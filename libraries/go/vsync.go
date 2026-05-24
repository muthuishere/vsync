package vsync

import (
	"context"
	"errors"
	"fmt"
)

// Fetcher abstracts the S3 round-trip. Returning a manifest + bundle +
// generation lets Open stay testable without spinning up AWS — the
// default fetcher in s3_fetcher.go uses aws-sdk-go-v2; tests inject a
// fake via WithFetcher.
type Fetcher interface {
	Fetch(ctx context.Context, cfg *Config) (manifest []byte, bundle []byte, generation int, err error)
}

// Options collects optional knobs for Open. Use the With* functional
// options below — keeps the call site idiomatic (`Open(ctx,
// WithDefaults(...))`) without forcing every caller through a struct.
type openOptions struct {
	fetcher  Fetcher
	defaults map[string]string
}

// Option configures Open.
type Option func(*openOptions)

// WithFetcher overrides the default S3 fetcher. Used by tests and by
// operators who want to plug in a non-S3 backend (e.g. a local fixture
// during integration).
func WithFetcher(f Fetcher) Option {
	return func(o *openOptions) { o.fetcher = f }
}

// WithDefaults seeds the fallback chain's lowest tier (v0.12 §5).
func WithDefaults(d map[string]string) Option {
	return func(o *openOptions) {
		o.defaults = make(map[string]string, len(d))
		for k, v := range d {
			o.defaults[k] = v
		}
	}
}

// Open reads VSYNC_CONFIG + VSYNC_PASSPHRASE from the process env (or
// their _FILE variants), runs one S3 round trip, decrypts the bundle,
// and returns an in-memory Client. No retries on success-path; no
// refresh thread; one fetch and done (v0.12 §7).
//
// The ctx is honored on the S3 fetch. After Fetch returns, the rest of
// Open is pure-memory and ignores ctx.
//
// Errors are sentinels usable with errors.Is — see v0.12 §11 and the
// declarations in errors.go.
func Open(ctx context.Context, opts ...Option) (*Client, error) {
	cfgBlob, passphrase, err := ResolveBootstrapInputs()
	if err != nil {
		return nil, err // already a wrapped ErrConfigMissing
	}
	return openWithBootstrap(ctx, cfgBlob, passphrase, opts...)
}

// openWithBootstrap is the inner entry point that takes pre-resolved
// bootstrap inputs. Tests can call this directly to avoid env-var
// gymnastics in environments where Setenv is fiddly.
func openWithBootstrap(ctx context.Context, cfgBlob []byte, passphrase string, opts ...Option) (*Client, error) {
	cfg, err := DecodeConfigBlob(cfgBlob)
	if err != nil {
		return nil, err
	}
	// Salt string per Convention A — feed UTF-8 bytes verbatim to PBKDF2,
	// no base64-decode (v0.12 §2.1, post-bc52f51 spec correction).
	options := openOptions{}
	for _, o := range opts {
		o(&options)
	}
	if options.fetcher == nil {
		options.fetcher = defaultFetcher{}
	}

	manifestBytes, bundleBytes, generation, err := options.fetcher.Fetch(ctx, cfg)
	if err != nil {
		// Caller-provided sentinels (ErrS3Unreachable, ErrManifestNotFound)
		// propagate untouched. Anything else gets wrapped as
		// ErrS3Unreachable — the spec's "fail loud" policy (v0.12 §8).
		if isVSyncSentinel(err) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: S3 fetch failed: %v", ErrS3Unreachable, err)
	}

	// Belt-and-braces unwrap of the manifest. The default fetcher already
	// validates this; keeping the call here means a hand-rolled Fetcher
	// can return raw bytes without re-implementing the seal check.
	if _, _, err := UnwrapRQEM0001(manifestBytes); err != nil {
		return nil, err
	}
	plaintext, err := DecryptRQE1(bundleBytes, passphrase, cfg.Salt, cfg.Iterations)
	if err != nil {
		return nil, err
	}
	kv, assets, err := parseVaultPayload(plaintext)
	if err != nil {
		return nil, err
	}
	return &Client{
		kv:         kv,
		assets:     assets,
		defaults:   options.defaults,
		generation: generation,
		env:        cfg.Env,
	}, nil
}

// isVSyncSentinel reports whether err already wraps one of this library's
// canonical sentinels. Used to avoid double-wrapping in Open.
func isVSyncSentinel(err error) bool {
	for _, s := range []error{
		ErrConfigMissing,
		ErrConfigUnsupportedVersion,
		ErrS3Unreachable,
		ErrManifestNotFound,
		ErrWrongPassphrase,
		ErrBundleCorrupt,
		ErrUnsupportedSpecVersion,
	} {
		if errors.Is(err, s) {
			return true
		}
	}
	return false
}
