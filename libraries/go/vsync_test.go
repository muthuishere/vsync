package vsync

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
)

// fakeFetcher implements Fetcher for unit tests. Records the cfg it was
// called with and returns whatever bytes the test fixture supplies.
type fakeFetcher struct {
	manifest []byte
	bundle   []byte
	gen      int
	err      error
	called   bool
	cfg      *Config
}

func (f *fakeFetcher) Fetch(ctx context.Context, cfg *Config) (manifest []byte, bundle []byte, generation int, err error) {
	f.called = true
	f.cfg = cfg
	return f.manifest, f.bundle, f.gen, f.err
}

func makeConfigBlobForTest(t *testing.T, salt []byte, iterations int) []byte {
	t.Helper()
	inner := map[string]any{
		"v":               1,
		"endpoint":        "https://s3.example.com",
		"region":          "us-east-1",
		"bucket":          "b",
		"accessKeyId":     "k",
		"secretAccessKey": "s",
		"prefix":          "p/",
		"env":             "test",
		"salt":            base64.StdEncoding.EncodeToString(salt),
		"iterations":      iterations,
	}
	return buildConfigBlob(t, inner)
}

func TestOpenSuccess(t *testing.T) {
	t.Setenv("VSYNC_CONFIG", "")
	t.Setenv("VSYNC_PASSPHRASE", "")

	salt := []byte("AAAAAAAAAAAAAAAA") // 16 bytes
	passphrase := "passphrase"
	plaintext := []byte(`{"DATABASE_URL": "postgres://from-vault"}`)
	bundle, err := encryptRQE1ForTestRawSalt(plaintext, passphrase, salt, 600_000)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	manifest := wrapManifestForTest("20260524-000000", bundle)

	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", passphrase)

	f := &fakeFetcher{manifest: manifest, bundle: bundle, gen: 5}
	c, err := Open(context.Background(), WithFetcher(f))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer c.Close()
	if !f.called {
		t.Errorf("fetcher should have been called")
	}
	if v, _ := c.Get("DATABASE_URL"); v != "postgres://from-vault" {
		t.Errorf("vault Get failed: %q", v)
	}
	if c.Source("DATABASE_URL") != SourceVault {
		t.Errorf("source mismatch")
	}
	if c.Generation() != 5 {
		t.Errorf("gen mismatch: %d", c.Generation())
	}
}

func TestOpenMissingEnvSurfacesConfigMissing(t *testing.T) {
	t.Setenv("VSYNC_CONFIG", "")
	t.Setenv("VSYNC_PASSPHRASE", "")
	// In Go you can't fully unset via Setenv("", ""); the empty string
	// is still set. Use the From-map entry point to drive the test.
	_, _, err := ResolveBootstrapInputsFromMap(map[string]string{})
	if !errors.Is(err, ErrConfigMissing) {
		t.Fatalf("expected ErrConfigMissing, got %v", err)
	}
}

func TestOpenS3FetchErrorPropagates(t *testing.T) {
	salt := []byte("AAAAAAAAAAAAAAAA")
	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", "p")

	f := &fakeFetcher{err: ErrS3Unreachable}
	_, err := Open(context.Background(), WithFetcher(f))
	if !errors.Is(err, ErrS3Unreachable) {
		t.Fatalf("expected ErrS3Unreachable to propagate, got %v", err)
	}
}

func TestOpenManifestNotFoundPropagates(t *testing.T) {
	salt := []byte("AAAAAAAAAAAAAAAA")
	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", "p")

	f := &fakeFetcher{err: ErrManifestNotFound}
	_, err := Open(context.Background(), WithFetcher(f))
	if !errors.Is(err, ErrManifestNotFound) {
		t.Fatalf("expected ErrManifestNotFound, got %v", err)
	}
}

func TestOpenWrongPassphraseAfterFetch(t *testing.T) {
	salt := []byte("AAAAAAAAAAAAAAAA")
	bundle, _ := encryptRQE1ForTestRawSalt([]byte("{}"), "right-passphrase", salt, 600_000)
	manifest := wrapManifestForTest("20260524-000000", bundle)

	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", "wrong-passphrase")

	f := &fakeFetcher{manifest: manifest, bundle: bundle}
	_, err := Open(context.Background(), WithFetcher(f))
	if !errors.Is(err, ErrWrongPassphrase) {
		t.Fatalf("expected ErrWrongPassphrase, got %v", err)
	}
}

func TestOpenAcceptsDefaults(t *testing.T) {
	salt := []byte("AAAAAAAAAAAAAAAA")
	passphrase := "p"
	plaintext := []byte(`{}`)
	bundle, _ := encryptRQE1ForTestRawSalt(plaintext, passphrase, salt, 600_000)
	manifest := wrapManifestForTest("20260524-000000", bundle)

	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", passphrase)
	f := &fakeFetcher{manifest: manifest, bundle: bundle, gen: 1}

	c, err := Open(context.Background(), WithFetcher(f), WithDefaults(map[string]string{"PORT": "8080"}))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer c.Close()
	if v, _ := c.Get("PORT"); v != "8080" {
		t.Errorf("default value not honored: %q", v)
	}
	if c.Source("PORT") != SourceDefault {
		t.Errorf("source mismatch")
	}
}

// Helper that lets the vsync_test mint envelopes against the *raw* salt
// bytes path the runtime uses (matches Open's config-blob → decoded-salt
// flow). encryptRQE1ForTest uses the string flavor; for Open round-trips
// we need to mint with whatever salt bytes the config-blob will produce.
func encryptRQE1ForTestRawSalt(plaintext []byte, passphrase string, saltBytes []byte, iterations int) ([]byte, error) {
	// The runtime decrypt path uses []byte(salt) where salt comes from
	// the config blob's standard-base64-decoded field. To round-trip, we
	// pretend to be the CLI: encrypt with the same raw bytes.
	enc, err := encryptRQE1ForTest(plaintext, passphrase, string(saltBytes), iterations)
	return enc, err
}

// _used keeps json+test imports warm when individual subtests are run.
var _ = json.Marshal
