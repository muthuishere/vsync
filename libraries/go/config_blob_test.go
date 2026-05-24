package vsync

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// buildConfigBlob mints a valid wire blob from a Go map for unit tests.
// Matches the format scripts/generate-test-vectors.ts uses for positives.
func buildConfigBlob(t *testing.T, inner map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(inner)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var gz bytes.Buffer
	w, err := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	if err != nil {
		t.Fatalf("gzip writer: %v", err)
	}
	if _, err := w.Write(raw); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	body := base64.RawURLEncoding.EncodeToString(gz.Bytes())
	return []byte("vsync-cfg-v1:" + body)
}

func TestDecodeConfigBlobPositive(t *testing.T) {
	inner := map[string]any{
		"v":               1,
		"endpoint":        "https://s3.amazonaws.com",
		"region":          "us-east-1",
		"bucket":          "acme-secrets",
		"accessKeyId":     "AKIA0",
		"secretAccessKey": "xyz",
		"prefix":          "myapp/",
		"env":             "prod",
		"salt":            "AAAAAAAAAAAAAAAAAAAAAAAAAA==", // 19 base64 chars → ≥8 raw bytes
		"iterations":      600000,
	}
	blob := buildConfigBlob(t, inner)
	cfg, err := DecodeConfigBlob(blob)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.Endpoint != "https://s3.amazonaws.com" {
		t.Errorf("endpoint mismatch")
	}
	if cfg.Iterations != 600000 {
		t.Errorf("iterations mismatch: %d", cfg.Iterations)
	}
	if cfg.Salt != "AAAAAAAAAAAAAAAAAAAAAAAAAA==" {
		t.Errorf("salt mismatch")
	}
}

func TestDecodeConfigBlobRejectsWrongMagic(t *testing.T) {
	// Raw JSON without the magic prefix → ConfigMissingError.
	bad := []byte(`{"v":1,"endpoint":"https://s3"}`)
	_, err := DecodeConfigBlob(bad)
	if !errors.Is(err, ErrConfigMissing) {
		t.Fatalf("expected ErrConfigMissing, got %v", err)
	}
}

func TestDecodeConfigBlobRejectsStandardBase64(t *testing.T) {
	// Magic ok but the body uses '+' / '/' / '=' → ConfigUnsupportedVersion
	// per v0.12 §2.1 (standard alphabet MUST NOT be accepted).
	inner := map[string]any{"v": 1}
	raw, _ := json.Marshal(inner)
	var gz bytes.Buffer
	w, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	w.Write(raw)
	w.Close()
	stdB64 := base64.StdEncoding.EncodeToString(gz.Bytes())
	if !strings.ContainsAny(stdB64, "+/=") {
		// Ensure we constructed a body with a disallowed char; if not,
		// inject one explicitly.
		stdB64 = stdB64 + "="
	}
	blob := []byte("vsync-cfg-v1:" + stdB64)
	_, err := DecodeConfigBlob(blob)
	if !errors.Is(err, ErrConfigUnsupportedVersion) {
		t.Fatalf("expected ErrConfigUnsupportedVersion, got %v", err)
	}
}

func TestDecodeConfigBlobRejectsMalformedGzip(t *testing.T) {
	body := base64.RawURLEncoding.EncodeToString([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9})
	blob := []byte("vsync-cfg-v1:" + body)
	_, err := DecodeConfigBlob(blob)
	if !errors.Is(err, ErrBundleCorrupt) {
		t.Fatalf("expected ErrBundleCorrupt, got %v", err)
	}
}

func TestDecodeConfigBlobRejectsUnknownVersion(t *testing.T) {
	inner := map[string]any{
		"v":               99,
		"endpoint":        "https://s3",
		"region":          "us-east-1",
		"bucket":          "b",
		"accessKeyId":     "k",
		"secretAccessKey": "s",
		"prefix":          "",
		"env":             "prod",
		"salt":            "AAAAAAAAAAAAAAAAAAAAAAAAAA==",
		"iterations":      600000,
	}
	blob := buildConfigBlob(t, inner)
	_, err := DecodeConfigBlob(blob)
	if !errors.Is(err, ErrConfigUnsupportedVersion) {
		t.Fatalf("expected ErrConfigUnsupportedVersion, got %v", err)
	}
}

func TestDecodeConfigBlobRejectsTooShortSalt(t *testing.T) {
	// Decoded salt < 8 bytes → ConfigUnsupportedVersion per v0.12 §2.1.
	inner := map[string]any{
		"v":               1,
		"endpoint":        "https://s3",
		"region":          "us-east-1",
		"bucket":          "b",
		"accessKeyId":     "k",
		"secretAccessKey": "s",
		"prefix":          "",
		"env":             "prod",
		"salt":            base64.StdEncoding.EncodeToString([]byte{1, 2, 3}), // 3 bytes
		"iterations":      600000,
	}
	blob := buildConfigBlob(t, inner)
	_, err := DecodeConfigBlob(blob)
	if !errors.Is(err, ErrConfigUnsupportedVersion) {
		t.Fatalf("expected ErrConfigUnsupportedVersion for short salt, got %v", err)
	}
}
