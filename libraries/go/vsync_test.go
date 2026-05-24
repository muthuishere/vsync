package vsync

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// fakeFetcher implements Fetcher for unit tests. Records the cfg it was
// called with and returns whatever bytes the test fixture supplies. The
// `remoteGen` / `remoteErr` fields drive FetchManifest separately so the
// RemoteGeneration carve-out (v0.12 §4.5, §7.1) can be exercised in Open
// integration tests too — leave both zero/nil to mirror Fetch's gen.
type fakeFetcher struct {
	manifest      []byte
	bundle        []byte
	gen           int
	err           error
	called        bool
	cfg           *Config
	manifestCalls int
	remoteGen     int
	remoteGenSet  bool
	remoteErr     error
}

func (f *fakeFetcher) Fetch(ctx context.Context, cfg *Config) (manifest []byte, bundle []byte, generation int, err error) {
	f.called = true
	f.cfg = cfg
	return f.manifest, f.bundle, f.gen, f.err
}

func (f *fakeFetcher) FetchManifest(ctx context.Context, cfg *Config) (int, error) {
	f.manifestCalls++
	if f.remoteErr != nil {
		return 0, f.remoteErr
	}
	if f.remoteGenSet {
		return f.remoteGen, nil
	}
	return f.gen, nil
}

// makeConfigBlobForTest mints a blob that carries `saltString` verbatim
// (Convention A — the runtime feeds these UTF-8 bytes to PBKDF2 with no
// base64-decode). saltString must be ≥ configMinSaltChars to clear the
// sanity floor in DecodeConfigBlob.
func makeConfigBlobForTest(t *testing.T, saltString string, iterations int) []byte {
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
		"salt":            saltString,
		"iterations":      iterations,
	}
	return buildConfigBlob(t, inner)
}

func TestOpenSuccess(t *testing.T) {
	t.Setenv("VSYNC_CONFIG", "")
	t.Setenv("VSYNC_PASSPHRASE", "")

	salt := "AAAAAAAAAAAAAAAA" // 16 chars — clears the configMinSaltChars floor
	passphrase := "passphrase"
	plaintext := []byte(`{"DATABASE_URL": "postgres://from-vault"}`)
	bundle, err := encryptRQE1ForTest(plaintext, passphrase, salt, 600_000)
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
	if v, _ := c.GetEnv("DATABASE_URL"); v != "postgres://from-vault" {
		t.Errorf("vault GetEnv failed: %q", v)
	}
	if c.EnvSource("DATABASE_URL") != SourceVault {
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
	cfgBlob := makeConfigBlobForTest(t, "AAAAAAAAAAAAAAAA", 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", "p")

	f := &fakeFetcher{err: ErrS3Unreachable}
	_, err := Open(context.Background(), WithFetcher(f))
	if !errors.Is(err, ErrS3Unreachable) {
		t.Fatalf("expected ErrS3Unreachable to propagate, got %v", err)
	}
}

func TestOpenManifestNotFoundPropagates(t *testing.T) {
	cfgBlob := makeConfigBlobForTest(t, "AAAAAAAAAAAAAAAA", 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", "p")

	f := &fakeFetcher{err: ErrManifestNotFound}
	_, err := Open(context.Background(), WithFetcher(f))
	if !errors.Is(err, ErrManifestNotFound) {
		t.Fatalf("expected ErrManifestNotFound, got %v", err)
	}
}

func TestOpenWrongPassphraseAfterFetch(t *testing.T) {
	salt := "AAAAAAAAAAAAAAAA"
	bundle, _ := encryptRQE1ForTest([]byte("{}"), "right-passphrase", salt, 600_000)
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
	salt := "AAAAAAAAAAAAAAAA"
	passphrase := "p"
	plaintext := []byte(`{}`)
	bundle, _ := encryptRQE1ForTest(plaintext, passphrase, salt, 600_000)
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
	if v, _ := c.GetEnv("PORT"); v != "8080" {
		t.Errorf("default value not honored: %q", v)
	}
	if c.EnvSource("PORT") != SourceDefault {
		t.Errorf("source mismatch")
	}
}

func TestOpenWiresFetcherForRemoteGeneration(t *testing.T) {
	// End-to-end through Open: confirm the Client carries the injected
	// fetcher + decoded Config so RemoteGeneration can run after Open.
	salt := "AAAAAAAAAAAAAAAA"
	passphrase := "p"
	plaintext := []byte(`{}`)
	bundle, _ := encryptRQE1ForTest(plaintext, passphrase, salt, 600_000)
	manifest := wrapManifestForTest("20260524-000000", bundle)

	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", passphrase)

	f := &fakeFetcher{
		manifest:     manifest,
		bundle:       bundle,
		gen:          4,
		remoteGen:    9,
		remoteGenSet: true,
	}
	c, err := Open(context.Background(), WithFetcher(f))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer c.Close()
	if c.Generation() != 4 {
		t.Fatalf("Generation after Open: got %d, want 4", c.Generation())
	}
	remote, err := c.RemoteGeneration(context.Background())
	if err != nil {
		t.Fatalf("RemoteGeneration: %v", err)
	}
	if remote != 9 {
		t.Errorf("RemoteGeneration: got %d, want 9", remote)
	}
	// Local gen still untouched.
	if c.Generation() != 4 {
		t.Errorf("local gen mutated through Open path: got %d, want 4", c.Generation())
	}
	if f.manifestCalls != 1 {
		t.Errorf("FetchManifest call count: got %d, want 1", f.manifestCalls)
	}
}

// _used keeps json+test imports warm when individual subtests are run.
var _ = json.Marshal
