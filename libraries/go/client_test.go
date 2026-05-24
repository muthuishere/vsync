package vsync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
)

// fromVaultForTest mirrors Python's Vsync._from_vault — a test-only
// constructor that skips the S3 round-trip and seeds the in-memory vault
// directly. Drives the fallback-chain conformance vectors too.
func fromVaultForTest(kv map[string]string, assets map[string][]byte, defaults map[string]string, generation int, env string) *Client {
	c := &Client{
		kv:         make(map[string]string),
		assets:     make(map[string][]byte),
		defaults:   make(map[string]string),
		generation: generation,
		env:        env,
	}
	for k, v := range kv {
		c.kv[k] = v
	}
	for k, v := range assets {
		c.assets[k] = v
	}
	for k, v := range defaults {
		c.defaults[k] = v
	}
	return c
}

func TestClientFallbackChainOrder(t *testing.T) {
	// Wipe any test-runner env that might leak into the env step.
	for _, k := range []string{"DATABASE_URL", "STRIPE_KEY", "PORT", "MISSING_KEY"} {
		os.Unsetenv(k)
	}

	t.Setenv("STRIPE_KEY", "sk_live_env")
	t.Setenv("PORT", "9090")

	c := fromVaultForTest(
		map[string]string{"DATABASE_URL": "postgres://vault"},
		nil,
		map[string]string{"PORT": "8080"},
		7, "prod",
	)
	defer c.Close()

	// vault wins
	if v, _ := c.Get("DATABASE_URL"); v != "postgres://vault" {
		t.Errorf("vault precedence: got %q", v)
	}
	if c.Source("DATABASE_URL") != "vault" {
		t.Errorf("DATABASE_URL source != vault")
	}

	// env wins over default
	if v, _ := c.Get("STRIPE_KEY"); v != "sk_live_env" {
		t.Errorf("env precedence: got %q", v)
	}
	if c.Source("STRIPE_KEY") != "env" {
		t.Errorf("STRIPE_KEY source != env")
	}

	// PORT in both env and default — env wins
	if v, _ := c.Get("PORT"); v != "9090" {
		t.Errorf("env over default: got %q", v)
	}

	// missing
	if _, ok := c.Get("MISSING_KEY"); ok {
		t.Errorf("missing key should return ok=false")
	}
	if c.Source("MISSING_KEY") != "missing" {
		t.Errorf("missing source != missing")
	}
	if c.Has("MISSING_KEY") {
		t.Errorf("Has(missing) should be false")
	}
}

func TestClientHasAcrossLayers(t *testing.T) {
	os.Unsetenv("Z_LAYER")
	c := fromVaultForTest(
		map[string]string{"V": "1"},
		nil,
		map[string]string{"D": "2"},
		0, "test",
	)
	defer c.Close()
	t.Setenv("E", "3")

	for _, k := range []string{"V", "E", "D"} {
		if !c.Has(k) {
			t.Errorf("Has(%q) should be true", k)
		}
	}
	if c.Has("Z_LAYER") {
		t.Errorf("Has(unknown) should be false")
	}
}

func TestClientAssetBytes(t *testing.T) {
	bin := []byte{0x00, 0x01, 0x02, 0xff}
	c := fromVaultForTest(nil, map[string][]byte{"key.pem": bin}, nil, 0, "test")
	defer c.Close()

	got, err := c.AssetBytes("key.pem")
	if err != nil {
		t.Fatalf("AssetBytes: %v", err)
	}
	if !bytes.Equal(got, bin) {
		t.Errorf("bytes mismatch")
	}
	if _, err := c.AssetBytes("nope"); err == nil {
		t.Errorf("missing asset should error")
	}
}

func TestClientAssetBytesFallsThroughKVForBinaryAsString(t *testing.T) {
	// The asset-path conformance vectors store the binary value in the
	// vault as the .bin (injected as asset_bytes at construction by the
	// loader) — but the conformance harness occasionally seeds KV instead
	// of assets and asks for asset_bytes. Mirror Python's fallthrough.
	c := fromVaultForTest(map[string]string{"only-kv": "value-as-string"}, nil, nil, 0, "t")
	defer c.Close()
	got, err := c.AssetBytes("only-kv")
	if err != nil {
		t.Fatalf("KV fallthrough: %v", err)
	}
	if string(got) != "value-as-string" {
		t.Errorf("KV fallthrough returned %q", got)
	}
}

func TestClientAssetPathMaterialization(t *testing.T) {
	bin := []byte("PEM-shaped bytes")
	c := fromVaultForTest(nil, map[string][]byte{"svc.json": bin}, nil, 0, "t")

	path, err := c.AssetPath("svc.json")
	if err != nil {
		t.Fatalf("AssetPath: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := st.Mode().Perm(); mode != 0o600 {
		t.Errorf("mode = %o, want 0o600", mode)
	}
	data, _ := os.ReadFile(path)
	if !bytes.Equal(data, bin) {
		t.Errorf("file contents mismatch")
	}
	// Close unlinks.
	c.Close()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Close should remove materialized file; stat err = %v", err)
	}
}

func TestClientGeneration(t *testing.T) {
	c := fromVaultForTest(nil, nil, nil, 42, "test")
	defer c.Close()
	if c.Generation() != 42 {
		t.Errorf("Generation: got %d, want 42", c.Generation())
	}
}

func TestClientClosedHandleRejectsAccess(t *testing.T) {
	c := fromVaultForTest(map[string]string{"X": "y"}, nil, nil, 0, "t")
	c.Close()
	// Second close: no-op.
	c.Close()
	if _, ok := c.Get("X"); ok {
		t.Errorf("Get on closed handle should not succeed")
	}
}

func TestClientStringRedaction(t *testing.T) {
	c := fromVaultForTest(map[string]string{"DATABASE_URL": "postgres://very-secret"}, nil, nil, 7, "prod")
	defer c.Close()
	s := c.String()
	if bytes.Contains([]byte(s), []byte("very-secret")) {
		t.Errorf("String() leaked vault content: %q", s)
	}
	if !bytes.Contains([]byte(s), []byte("redacted")) {
		t.Errorf("String() should advertise redaction; got %q", s)
	}
}

func TestParseVaultPayloadFlatObject(t *testing.T) {
	// Flat JSON (no kv/assets nesting) — the fallback-chain corpus shape.
	kv, assets, err := parseVaultPayload([]byte(`{"FOO": "bar", "BAZ": "qux"}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if kv["FOO"] != "bar" || kv["BAZ"] != "qux" {
		t.Errorf("flat kv mismatch: %v", kv)
	}
	if len(assets) != 0 {
		t.Errorf("flat object should not produce assets")
	}
}

func TestParseVaultPayloadNestedKVAssets(t *testing.T) {
	body := []byte(`{"kv": {"A": "1"}, "assets": {"svc.json": "aGVsbG8="}}`)
	kv, assets, err := parseVaultPayload(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if kv["A"] != "1" {
		t.Errorf("kv mismatch")
	}
	if string(assets["svc.json"]) != "hello" {
		t.Errorf("asset base64 decode mismatch: got %q", assets["svc.json"])
	}
}

func TestParseVaultPayloadRejectsNonObject(t *testing.T) {
	_, _, err := parseVaultPayload([]byte(`["not", "an", "object"]`))
	if !errors.Is(err, ErrBundleCorrupt) {
		t.Fatalf("expected ErrBundleCorrupt, got %v", err)
	}
}

// stubManifestFetcher is a Fetcher used by the RemoteGeneration / HasNewVersion
// tests. The constructor lets the test seed (a) the open-time gen, (b) the
// follow-up RemoteGeneration result (or error). All other Fetcher inputs
// (manifest/bundle) are nil — the tests construct the Client via
// fromVaultWithFetcherForTest, skipping Open's decrypt path entirely.
type stubManifestFetcher struct {
	openGen   int
	remoteGen int
	remoteErr error
	calls     int
}

func (s *stubManifestFetcher) Fetch(ctx context.Context, cfg *Config) ([]byte, []byte, int, error) {
	return nil, nil, s.openGen, nil
}

func (s *stubManifestFetcher) FetchManifest(ctx context.Context, cfg *Config) (int, error) {
	s.calls++
	if s.remoteErr != nil {
		return 0, s.remoteErr
	}
	return s.remoteGen, nil
}

// fromVaultWithFetcherForTest is like fromVaultForTest but also wires a
// Fetcher + Config onto the Client so RemoteGeneration / HasNewVersion can
// be exercised without an S3 round-trip.
func fromVaultWithFetcherForTest(generation int, env string, f Fetcher, cfg *Config) *Client {
	c := fromVaultForTest(nil, nil, nil, generation, env)
	c.fetcher = f
	c.cfg = cfg
	return c
}

func TestRemoteGenerationReturnsRemoteGenLeavesLocalUntouched(t *testing.T) {
	stub := &stubManifestFetcher{openGen: 5, remoteGen: 7}
	c := fromVaultWithFetcherForTest(5, "prod", stub, &Config{})
	defer c.Close()

	if c.Generation() != 5 {
		t.Fatalf("local gen at open: got %d, want 5", c.Generation())
	}
	remote, err := c.RemoteGeneration(context.Background())
	if err != nil {
		t.Fatalf("RemoteGeneration: %v", err)
	}
	if remote != 7 {
		t.Errorf("RemoteGeneration: got %d, want 7", remote)
	}
	// Polling must NOT mutate the local gen (v0.12 §4.5).
	if c.Generation() != 5 {
		t.Errorf("local gen mutated by RemoteGeneration: got %d, want 5", c.Generation())
	}
}

func TestRemoteGenerationReturnsErrS3UnreachableOnNetworkFailure(t *testing.T) {
	stub := &stubManifestFetcher{
		openGen:   3,
		remoteErr: fmt.Errorf("%w: connection refused", ErrS3Unreachable),
	}
	c := fromVaultWithFetcherForTest(3, "prod", stub, &Config{})
	defer c.Close()

	_, err := c.RemoteGeneration(context.Background())
	if !errors.Is(err, ErrS3Unreachable) {
		t.Fatalf("expected ErrS3Unreachable, got %v", err)
	}
}

func TestRemoteGenerationReturnsErrManifestNotFoundOn404(t *testing.T) {
	stub := &stubManifestFetcher{
		openGen:   2,
		remoteErr: fmt.Errorf("%w: object 404", ErrManifestNotFound),
	}
	c := fromVaultWithFetcherForTest(2, "prod", stub, &Config{})
	defer c.Close()

	_, err := c.RemoteGeneration(context.Background())
	if !errors.Is(err, ErrManifestNotFound) {
		t.Fatalf("expected ErrManifestNotFound, got %v", err)
	}
}

func TestHasNewVersionTrueWhenLocalBehind(t *testing.T) {
	stub := &stubManifestFetcher{openGen: 3, remoteGen: 4}
	c := fromVaultWithFetcherForTest(3, "prod", stub, &Config{})
	defer c.Close()

	stale, err := c.HasNewVersion(context.Background())
	if err != nil {
		t.Fatalf("HasNewVersion: %v", err)
	}
	if !stale {
		t.Errorf("HasNewVersion: local=3 remote=4 should be true")
	}
}

func TestHasNewVersionFalseWhenLocalCurrent(t *testing.T) {
	stub := &stubManifestFetcher{openGen: 5, remoteGen: 5}
	c := fromVaultWithFetcherForTest(5, "prod", stub, &Config{})
	defer c.Close()

	stale, err := c.HasNewVersion(context.Background())
	if err != nil {
		t.Fatalf("HasNewVersion: %v", err)
	}
	if stale {
		t.Errorf("HasNewVersion: local=5 remote=5 should be false")
	}
}

func TestHasNewVersionFalseWhenLocalAhead(t *testing.T) {
	stub := &stubManifestFetcher{openGen: 10, remoteGen: 8}
	c := fromVaultWithFetcherForTest(10, "prod", stub, &Config{})
	defer c.Close()

	stale, err := c.HasNewVersion(context.Background())
	if err != nil {
		t.Fatalf("HasNewVersion: %v", err)
	}
	if stale {
		t.Errorf("HasNewVersion: local=10 remote=8 should be false")
	}
}

func TestHasNewVersionPropagatesError(t *testing.T) {
	stub := &stubManifestFetcher{
		openGen:   3,
		remoteErr: fmt.Errorf("%w: dns lookup", ErrS3Unreachable),
	}
	c := fromVaultWithFetcherForTest(3, "prod", stub, &Config{})
	defer c.Close()

	stale, err := c.HasNewVersion(context.Background())
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, ErrS3Unreachable) {
		t.Fatalf("expected ErrS3Unreachable, got %v", err)
	}
	if stale {
		t.Errorf("HasNewVersion: on error, stale should be false; got true")
	}
}
