package vsync

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
)

// Source labels the step in the fallback chain (v0.12 §5) that resolved a
// key. Safe to log — never carries the value itself.
type Source string

const (
	SourceVault   Source = "vault"
	SourceEnv     Source = "env"
	SourceDefault Source = "default"
	SourceMissing Source = "missing"
)

// Client is the in-memory accessor for a decrypted vault. Construct via
// Open(ctx, opts...) or OpenWith(ctx, cfg, passphrase, opts...). All
// pure-memory accessors (GetEnv, HasEnv, EnvSource, GetAsContent,
// Generation) are safe to call from any goroutine without coordination
// as long as the vault is not concurrently being Closed.
//
// Redaction (v0.12 §12): String() / fmt.Stringer surfaces only the env
// name and the generation counter. Vault values never appear in the
// handle's string form.
type Client struct {
	kv         map[string]string
	assets     map[string][]byte
	defaults   map[string]string
	generation int
	env        string
	closed     bool
	// fetcher + cfg are retained from Open so RemoteGeneration /
	// HasNewVersion can issue a fresh manifest read without re-resolving
	// the bootstrap inputs. nil when the Client was constructed via a
	// test helper that skipped Open (the methods then return an error).
	fetcher Fetcher
	cfg     *Config
}

// GetEnv resolves key through vault → env → defaults → missing (v0.12 §5).
// The second return is false when the key resolved to "missing" (or the
// client is closed).
func (c *Client) GetEnv(key string) (string, bool) {
	if c.closed {
		return "", false
	}
	if v, ok := c.kv[key]; ok {
		return v, true
	}
	// os.Getenv at lookup time, not Open time — so process-env mutations
	// after Open are visible (v0.12 §5).
	if v, ok := os.LookupEnv(key); ok {
		return v, true
	}
	if v, ok := c.defaults[key]; ok {
		return v, true
	}
	return "", false
}

// HasEnv returns true iff vault, env, or defaults would resolve key.
func (c *Client) HasEnv(key string) bool {
	if c.closed {
		return false
	}
	if _, ok := c.kv[key]; ok {
		return true
	}
	if _, ok := os.LookupEnv(key); ok {
		return true
	}
	_, ok := c.defaults[key]
	return ok
}

// EnvSource names the step in the fallback chain that wins (or
// SourceMissing). Never returns the value itself — safe to log.
func (c *Client) EnvSource(key string) Source {
	if c.closed {
		return SourceMissing
	}
	if _, ok := c.kv[key]; ok {
		return SourceVault
	}
	if _, ok := os.LookupEnv(key); ok {
		return SourceEnv
	}
	if _, ok := c.defaults[key]; ok {
		return SourceDefault
	}
	return SourceMissing
}

// GetAsContent returns the binary payload for name as raw bytes. Never
// touches the filesystem (v0.12 §6). Callers who need a filesystem path
// (GCP GOOGLE_APPLICATION_CREDENTIALS, OpenSSL cert file, JVM keystore)
// must write the bytes to a tempfile themselves.
//
// Lookup order: assets map, then KV — the KV fallthrough exists so
// conformance vectors that seed the binary value into KV-as-string
// round-trip cleanly.
func (c *Client) GetAsContent(name string) ([]byte, error) {
	if c.closed {
		return nil, fmt.Errorf("vsync: handle is closed")
	}
	if b, ok := c.assets[name]; ok {
		// Copy so callers can't mutate the in-memory vault by accident.
		out := make([]byte, len(b))
		copy(out, b)
		return out, nil
	}
	if v, ok := c.kv[name]; ok {
		return []byte(v), nil
	}
	return nil, fmt.Errorf("vsync: asset %q not in vault", name)
}

// Generation returns the monotonic gen counter from the manifest meta
// cell. Safe to log; useful in /healthz to assert the pod is on the
// latest vault.
func (c *Client) Generation() int {
	return c.generation
}

// RemoteGeneration issues one manifest read against S3 and returns the
// current gen counter. Does NOT mutate the local generation (v0.12 §4.5,
// §7.1 — pull-once carve-out for explicit polling).
//
// Returns (0, ErrS3Unreachable) on network failure, (0,
// ErrManifestNotFound) on 404. The local Generation() value stays
// whatever Open captured.
func (c *Client) RemoteGeneration(ctx context.Context) (int64, error) {
	if c.closed {
		return 0, fmt.Errorf("vsync: handle is closed")
	}
	if c.fetcher == nil || c.cfg == nil {
		return 0, fmt.Errorf("vsync: client has no fetcher (constructed outside Open)")
	}
	gen, err := c.fetcher.FetchManifest(ctx, c.cfg)
	if err != nil {
		// Caller-provided sentinels propagate untouched; anything else gets
		// wrapped as ErrS3Unreachable to match the Open path's fail-loud
		// classification.
		if isVSyncSentinel(err) {
			return 0, err
		}
		return 0, fmt.Errorf("%w: manifest fetch failed: %v", ErrS3Unreachable, err)
	}
	return int64(gen), nil
}

// HasNewVersion reports whether the upstream gen is strictly greater
// than the local gen captured at Open. Convenience over RemoteGeneration
// for /healthz endpoints and sidecar crons (v0.12 §7.1) — restart is
// still the only way to actually adopt the new bundle.
//
// On error, returns (false, err) where err propagates the underlying
// RemoteGeneration failure.
func (c *Client) HasNewVersion(ctx context.Context) (bool, error) {
	remote, err := c.RemoteGeneration(ctx)
	if err != nil {
		return false, err
	}
	return remote > int64(c.generation), nil
}

// Close releases the in-memory vault. Idempotent.
func (c *Client) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	// Zero out the maps so a post-close pointer-leak doesn't keep secrets
	// reachable. (Go has no guaranteed memory-zero; this is hygiene, not
	// a hard guarantee.)
	for k := range c.kv {
		delete(c.kv, k)
	}
	for k := range c.assets {
		delete(c.assets, k)
	}
	return nil
}

// String returns a redaction-safe representation (v0.12 §12).
func (c *Client) String() string {
	return fmt.Sprintf("<vsync:redacted gen=%d env=%s>", c.generation, c.env)
}

// parseVaultPayload decodes the decrypted bundle plaintext into (kv,
// assets). Two shapes are accepted:
//
//   - flat object: every value is a string KV (also what the
//     fallback-chain conformance vectors use)
//   - nested:  { "kv": {...}, "assets": {<name>: <base64>} }
//
// Wire format detail mirrors Python's libraries/python/.../client.py — the
// spec is implicit on this; the corpus and the Python reference impl pin
// the shape.
func parseVaultPayload(payload []byte) (map[string]string, map[string][]byte, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, nil, fmt.Errorf("%w: vault payload is not valid JSON object: %v", ErrBundleCorrupt, err)
	}
	kv := make(map[string]string)
	assets := make(map[string][]byte)

	_, hasKV := raw["kv"]
	_, hasAssets := raw["assets"]
	if hasKV || hasAssets {
		if v, ok := raw["kv"]; ok {
			if err := json.Unmarshal(v, &kv); err != nil {
				return nil, nil, fmt.Errorf("%w: vault.kv must be a string->string object: %v", ErrBundleCorrupt, err)
			}
		}
		if v, ok := raw["assets"]; ok {
			var rawAssets map[string]string
			if err := json.Unmarshal(v, &rawAssets); err != nil {
				return nil, nil, fmt.Errorf("%w: vault.assets must be a string->string (base64) object: %v", ErrBundleCorrupt, err)
			}
			for name, b64 := range rawAssets {
				dec, err := base64.StdEncoding.DecodeString(b64)
				if err != nil {
					return nil, nil, fmt.Errorf("%w: vault.assets[%q] is not valid base64: %v", ErrBundleCorrupt, name, err)
				}
				assets[name] = dec
			}
		}
		return kv, assets, nil
	}

	// Flat: every value must be a string.
	for k, v := range raw {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return nil, nil, fmt.Errorf("%w: vault[%q] must be a string in flat shape: %v", ErrBundleCorrupt, k, err)
		}
		kv[k] = s
	}
	return kv, assets, nil
}
