package vsync

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
)

// VSYNC_CONFIG bootstrap blob (v0.12 §2.1):
//
//	vsync-cfg-v1:<base64url-no-pad(gzip(JSON))>
//
// The magic prefix is the schema-version handle. Wrong prefix → ConfigMissing.
// Standard base64 (any of '+', '/', '=') in the body → ConfigUnsupportedVersion
// (the operator hand-rolled with the wrong alphabet — surface that loudly
// rather than silently translating).

const (
	configBlobMagic   = "vsync-cfg-v1:"
	supportedInnerV   = 1
	// Sanity floor on the salt's character length. The CLI emits a 24-char
	// base64url ASCII string today; we floor at 16 chars so a typo'd /
	// truncated blob still fails fast. The bytes fed to PBKDF2 are these
	// chars' UTF-8 encoding verbatim — NOT base64-decoded. See v0.12 §2.1
	// "Readers MUST feed the UTF-8 bytes of this string directly to PBKDF2".
	configMinSaltChars = 16
	bytesGzipMagicLen  = 2 // gzip stream starts with 0x1f 0x8b
)

// Config holds the decoded inner JSON of a VSYNC_CONFIG blob. Field names
// mirror v0.12 §2.1; JSON tags map the camelCase wire form.
type Config struct {
	V               int    `json:"v"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	Prefix          string `json:"prefix"`
	Env             string `json:"env"`
	// Salt is the PBKDF2 salt as it appears in the blob. Readers MUST feed
	// the UTF-8 bytes of this string verbatim to PBKDF2 (v0.12 §2.1, post-
	// bc52f51 spec correction); do NOT base64-decode first, even though
	// the CLI happens to mint a base64url-shaped string.
	Salt            string `json:"salt"`
	Iterations      int    `json:"iterations"` // PBKDF2-SHA256 work factor
}

// DecodeConfigBlob parses a VSYNC_CONFIG blob into a *Config. Errors map
// to v0.12 §11:
//   - missing/wrong magic prefix → ErrConfigMissing
//   - standard-alphabet base64    → ErrConfigUnsupportedVersion
//   - inner v != 1                → ErrConfigUnsupportedVersion
//   - gzip / json fail            → ErrBundleCorrupt
func DecodeConfigBlob(blob []byte) (*Config, error) {
	if !bytes.HasPrefix(blob, []byte(configBlobMagic)) {
		return nil, fmt.Errorf("%w: VSYNC_CONFIG missing 'vsync-cfg-v1:' prefix — raw JSON or wrong version?", ErrConfigMissing)
	}
	body := blob[len(configBlobMagic):]
	// Strict base64url rejection. Any of '+', '/', '=' is the standard
	// alphabet — refuse rather than silently re-encode (which would mask
	// the operator's bug).
	for _, c := range body {
		if c == '+' || c == '/' || c == '=' {
			return nil, fmt.Errorf("%w: body must be base64url-no-pad (RFC 4648 §5); found disallowed char %q",
				ErrConfigUnsupportedVersion, c)
		}
	}
	gz, err := base64.RawURLEncoding.DecodeString(string(body))
	if err != nil {
		return nil, fmt.Errorf("%w: base64url body failed to decode: %v", ErrBundleCorrupt, err)
	}
	// Cheap sniff: a real gzip stream starts with 0x1f 0x8b. Catches the
	// "magic ok + valid base64 of junk bytes" malformed-gzip negative
	// vector before we burn cycles in compress/gzip's reader.
	if len(gz) < bytesGzipMagicLen || gz[0] != 0x1f || gz[1] != 0x8b {
		return nil, fmt.Errorf("%w: body is not a gzip stream (wrong magic bytes)", ErrBundleCorrupt)
	}
	r, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil, fmt.Errorf("%w: gzip reader init failed: %v", ErrBundleCorrupt, err)
	}
	defer r.Close()
	rawJSON, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("%w: gzip decompress failed: %v", ErrBundleCorrupt, err)
	}

	// Parse just `v` first so we can surface ConfigUnsupportedVersion
	// before any other field-level validation. The corpus's
	// negative-unknown-version vector relies on this ordering.
	var probe struct {
		V int `json:"v"`
	}
	if err := json.Unmarshal(rawJSON, &probe); err != nil {
		return nil, fmt.Errorf("%w: inner JSON failed to parse: %v", ErrBundleCorrupt, err)
	}
	if probe.V != supportedInnerV {
		return nil, fmt.Errorf("%w: inner v=%d; this library understands v=1 only", ErrConfigUnsupportedVersion, probe.V)
	}

	var cfg Config
	if err := json.Unmarshal(rawJSON, &cfg); err != nil {
		return nil, fmt.Errorf("%w: inner JSON failed to parse: %v", ErrBundleCorrupt, err)
	}
	if cfg.Iterations <= 0 {
		return nil, fmt.Errorf("%w: iterations must be > 0, got %d", ErrBundleCorrupt, cfg.Iterations)
	}
	// Sanity floor on the salt string's length — keeps obvious typos from
	// silently weakening PBKDF2 input. The CLI's on-disk salts are 24 chars;
	// 16 is forgiving without being meaningless. v0.12 §2.1 mandates the
	// rejection point but lets the lib pick the threshold.
	if len(cfg.Salt) < configMinSaltChars {
		return nil, fmt.Errorf("%w: salt string is %d chars (< %d minimum)",
			ErrConfigUnsupportedVersion, len(cfg.Salt), configMinSaltChars)
	}
	return &cfg, nil
}
