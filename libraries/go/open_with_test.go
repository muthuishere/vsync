package vsync

import (
	"context"
	"errors"
	"testing"
)

// OpenWith mirrors Open but accepts the bootstrap inputs as string args
// directly — for callers whose config lives in a KMS / Hashicorp Vault /
// CI variable, not in the process env (v0.12 §4.3 / §4.5).

func TestOpenWithAcceptsStringConfigAndPassphrase(t *testing.T) {
	salt := "AAAAAAAAAAAAAAAA"
	passphrase := "passphrase"
	plaintext := []byte(`{"DATABASE_URL": "postgres://from-vault"}`)
	bundle, err := encryptRQE1ForTest(plaintext, passphrase, salt, 600_000)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	manifest := wrapManifestForTest("20260524-000000", bundle)
	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)

	// No env vars set — OpenWith must NOT touch process env for bootstrap.
	t.Setenv("VSYNC_CONFIG", "")
	t.Setenv("VSYNC_PASSPHRASE", "")

	f := &fakeFetcher{manifest: manifest, bundle: bundle, gen: 5}
	c, err := OpenWith(context.Background(), string(cfgBlob), passphrase, WithFetcher(f))
	if err != nil {
		t.Fatalf("OpenWith: %v", err)
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

func TestOpenWithReturnsErrConfigMissingOnEmptyConfig(t *testing.T) {
	c, err := OpenWith(context.Background(), "", "passphrase")
	if c != nil {
		t.Errorf("expected nil client, got %v", c)
	}
	if !errors.Is(err, ErrConfigMissing) {
		t.Fatalf("expected ErrConfigMissing, got %v", err)
	}
}

func TestOpenWithReturnsErrConfigMissingOnEmptyPassphrase(t *testing.T) {
	cfgBlob := makeConfigBlobForTest(t, "AAAAAAAAAAAAAAAA", 600_000)
	c, err := OpenWith(context.Background(), string(cfgBlob), "")
	if c != nil {
		t.Errorf("expected nil client, got %v", c)
	}
	if !errors.Is(err, ErrConfigMissing) {
		t.Fatalf("expected ErrConfigMissing, got %v", err)
	}
}

func TestOpenWithThreadsDefaultsToClient(t *testing.T) {
	salt := "AAAAAAAAAAAAAAAA"
	passphrase := "p"
	plaintext := []byte(`{}`)
	bundle, _ := encryptRQE1ForTest(plaintext, passphrase, salt, 600_000)
	manifest := wrapManifestForTest("20260524-000000", bundle)
	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)

	f := &fakeFetcher{manifest: manifest, bundle: bundle, gen: 1}
	c, err := OpenWith(
		context.Background(),
		string(cfgBlob),
		passphrase,
		WithFetcher(f),
		WithDefaults(map[string]string{"PORT": "8080"}),
	)
	if err != nil {
		t.Fatalf("OpenWith: %v", err)
	}
	defer c.Close()
	if v, _ := c.GetEnv("PORT"); v != "8080" {
		t.Errorf("default value not honored: %q", v)
	}
	if c.EnvSource("PORT") != SourceDefault {
		t.Errorf("source mismatch")
	}
}

func TestOpenWithYieldsByteIdenticalDecryptionAsOpenForSameInputs(t *testing.T) {
	salt := "AAAAAAAAAAAAAAAA"
	passphrase := "passphrase"
	plaintext := []byte(`{"A": "alpha", "B": "beta", "C": "gamma"}`)
	bundle, err := encryptRQE1ForTest(plaintext, passphrase, salt, 600_000)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	manifest := wrapManifestForTest("20260524-000000", bundle)
	cfgBlob := makeConfigBlobForTest(t, salt, 600_000)

	// Open path — bootstrap from env.
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", passphrase)
	fA := &fakeFetcher{manifest: manifest, bundle: bundle, gen: 9}
	cOpen, err := Open(context.Background(), WithFetcher(fA))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer cOpen.Close()

	// OpenWith path — strings directly.
	fB := &fakeFetcher{manifest: manifest, bundle: bundle, gen: 9}
	cOpenWith, err := OpenWith(context.Background(), string(cfgBlob), passphrase, WithFetcher(fB))
	if err != nil {
		t.Fatalf("OpenWith: %v", err)
	}
	defer cOpenWith.Close()

	for _, key := range []string{"A", "B", "C"} {
		want, _ := cOpen.GetEnv(key)
		got, _ := cOpenWith.GetEnv(key)
		if want != got {
			t.Errorf("decryption divergence at %q: Open=%q OpenWith=%q", key, want, got)
		}
	}
	if cOpen.Generation() != cOpenWith.Generation() {
		t.Errorf("generation divergence: Open=%d OpenWith=%d", cOpen.Generation(), cOpenWith.Generation())
	}
}
