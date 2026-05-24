package vsync

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Conformance suite per v0.11 §7. Walks the shared corpus at
// docs/specs/test-vectors/<category>/*.json, pairs the sibling .bin, and
// dispatches by category. Negative cases are matched via errors.Is +
// CanonicalName against the v0.12 §11 taxonomy.

const corpusRelPath = "../../docs/specs/test-vectors"

var conformanceCategories = []string{
	"rqe1-decrypt",
	"rqe1-decrypt-error",
	"rqem0001-manifest",
	"config-blob",
	"fallback-chain",
	"asset-path",
	"error-taxonomy",
}

type vector struct {
	Category    string
	Name        string
	JSONPath    string
	BinPath     string
	Meta        map[string]any
	BinBytes    []byte
}

func (v vector) expectedError() string {
	if exp, ok := v.Meta["expected"].(map[string]any); ok {
		if e, ok := exp["error"].(string); ok {
			return e
		}
	}
	return ""
}

func (v vector) inputs() map[string]any {
	if in, ok := v.Meta["inputs"].(map[string]any); ok {
		return in
	}
	return map[string]any{}
}

func corpusRoot(t *testing.T) string {
	t.Helper()
	if override := os.Getenv("VSYNC_TEST_VECTORS_DIR"); override != "" {
		return override
	}
	abs, err := filepath.Abs(corpusRelPath)
	if err != nil {
		t.Fatalf("resolve corpus path: %v", err)
	}
	return abs
}

func loadCategory(t *testing.T, root, category string) []vector {
	t.Helper()
	dir := filepath.Join(root, category)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read corpus dir %s: %v", dir, err)
	}
	var out []vector
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		jsonPath := filepath.Join(dir, e.Name())
		raw, err := os.ReadFile(jsonPath)
		if err != nil {
			t.Fatalf("read %s: %v", jsonPath, err)
		}
		var meta map[string]any
		if err := json.Unmarshal(raw, &meta); err != nil {
			t.Fatalf("parse %s: %v", jsonPath, err)
		}
		v := vector{
			Category: category,
			Name:     strings.TrimSuffix(e.Name(), ".json"),
			JSONPath: jsonPath,
			Meta:     meta,
		}
		binPath := strings.TrimSuffix(jsonPath, ".json") + ".bin"
		if b, err := os.ReadFile(binPath); err == nil {
			v.BinPath = binPath
			v.BinBytes = b
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func assertErrorName(t *testing.T, v vector, err error) {
	t.Helper()
	want := v.expectedError()
	if err == nil {
		t.Fatalf("%s/%s: expected error %q, got nil", v.Category, v.Name, want)
	}
	got := CanonicalName(err)
	if got != want {
		t.Fatalf("%s/%s: expected canonical error %q, got %q (raw: %v)",
			v.Category, v.Name, want, got, err)
	}
}

func TestConformanceCorpusIsPresent(t *testing.T) {
	// Sanity gate — silent empty corpus would let every parametrized
	// case below report zero failures and zero successes, masking a
	// broken setup. Mirror Python's test_corpus_is_non_empty.
	root := corpusRoot(t)
	total := 0
	for _, cat := range conformanceCategories {
		total += len(loadCategory(t, root, cat))
	}
	if total < 20 {
		t.Fatalf("corpus too small: %d vectors across 7 categories — was it regenerated?", total)
	}
}

func TestConformanceRQE1Decrypt(t *testing.T) {
	root := corpusRoot(t)
	for _, v := range loadCategory(t, root, "rqe1-decrypt") {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			if v.BinBytes == nil {
				t.Fatalf(".bin required")
			}
			in := v.inputs()
			pp, _ := in["passphrase"].(string)
			salt, _ := in["salt"].(string)
			pt, err := DecryptRQE1(v.BinBytes, pp, salt, 600_000)
			if err != nil {
				t.Fatalf("DecryptRQE1: %v", err)
			}
			exp := v.Meta["expected"].(map[string]any)
			wantHex, _ := exp["plaintext_hex"].(string)
			if got := hex.EncodeToString(pt); got != wantHex {
				t.Fatalf("plaintext mismatch: got %s want %s", got, wantHex)
			}
		})
	}
}

func TestConformanceRQE1DecryptError(t *testing.T) {
	root := corpusRoot(t)
	for _, v := range loadCategory(t, root, "rqe1-decrypt-error") {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			if v.BinBytes == nil {
				t.Fatalf(".bin required")
			}
			in := v.inputs()
			pp, _ := in["passphrase"].(string)
			salt, _ := in["salt"].(string)
			_, err := DecryptRQE1(v.BinBytes, pp, salt, 600_000)
			assertErrorName(t, v, err)
		})
	}
}

func TestConformanceManifest(t *testing.T) {
	root := corpusRoot(t)
	for _, v := range loadCategory(t, root, "rqem0001-manifest") {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			if v.BinBytes == nil {
				t.Fatalf(".bin required")
			}
			exp := v.Meta["expected"].(map[string]any)
			in := v.inputs()
			remoteTS, _ := in["remote_ts"].(string)
			wantErr, _ := exp["error"].(string)
			if wantErr != "" {
				var err error
				if remoteTS != "" {
					_, _, err = VerifyManifestAgainstRemoteTS(v.BinBytes, remoteTS)
				} else {
					_, _, err = UnwrapRQEM0001(v.BinBytes)
				}
				assertErrorName(t, v, err)
				return
			}
			ts, payload, err := VerifyManifestAgainstRemoteTS(v.BinBytes, remoteTS)
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			wantTS, _ := exp["embedded_ts"].(string)
			if ts != wantTS {
				t.Fatalf("ts mismatch: %s vs %s", ts, wantTS)
			}
			wantHex, _ := exp["payload_hex"].(string)
			if got := hex.EncodeToString(payload); got != wantHex {
				t.Fatalf("payload mismatch")
			}
		})
	}
}

func TestConformanceConfigBlob(t *testing.T) {
	root := corpusRoot(t)
	for _, v := range loadCategory(t, root, "config-blob") {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			if v.BinBytes == nil {
				t.Fatalf(".bin required")
			}
			exp := v.Meta["expected"].(map[string]any)
			wantErr, _ := exp["error"].(string)
			cfg, err := DecodeConfigBlob(v.BinBytes)
			if wantErr != "" {
				assertErrorName(t, v, err)
				return
			}
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			wantJSON, _ := exp["config_json"].(map[string]any)
			gotJSON := map[string]any{
				"v":               float64(cfg.V),
				"endpoint":        cfg.Endpoint,
				"region":          cfg.Region,
				"bucket":          cfg.Bucket,
				"accessKeyId":     cfg.AccessKeyID,
				"secretAccessKey": cfg.SecretAccessKey,
				"prefix":          cfg.Prefix,
				"env":             cfg.Env,
				"salt":            cfg.Salt,
				"iterations":      float64(cfg.Iterations),
			}
			if !mapsEqual(gotJSON, wantJSON) {
				t.Fatalf("config JSON mismatch:\ngot:  %v\nwant: %v", gotJSON, wantJSON)
			}
		})
	}
}

func mapsEqual(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for k, av := range a {
		bv, ok := b[k]
		if !ok {
			return false
		}
		// json.Unmarshal turns numbers into float64 — compare as such.
		switch ax := av.(type) {
		case float64:
			bx, ok := bv.(float64)
			if !ok || ax != bx {
				return false
			}
		case string:
			bx, ok := bv.(string)
			if !ok || ax != bx {
				return false
			}
		default:
			// Defer to == for anything else (booleans, nils).
			if av != bv {
				return false
			}
		}
	}
	return true
}

func TestConformanceFallbackChain(t *testing.T) {
	root := corpusRoot(t)
	for _, v := range loadCategory(t, root, "fallback-chain") {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			in := v.inputs()
			vault := stringMap(in["vault"])
			envOverrides := stringMap(in["env"])
			defaults := stringMap(in["defaults"])
			queries := stringSlice(in["queries"])
			exp := v.Meta["expected"].(map[string]any)
			results, _ := exp["results"].([]any)

			// Wipe any test-runner env that might leak in for the keys
			// this vector touches.
			touched := map[string]bool{}
			for k := range envOverrides {
				touched[k] = true
			}
			for _, r := range results {
				rm := r.(map[string]any)
				touched[rm["key"].(string)] = true
			}
			for k := range touched {
				orig, hadOrig := os.LookupEnv(k)
				os.Unsetenv(k)
				if hadOrig {
					t.Cleanup(func() { os.Setenv(k, orig) })
				} else {
					t.Cleanup(func() { os.Unsetenv(k) })
				}
			}
			for k, val := range envOverrides {
				os.Setenv(k, val)
			}

			c := fromVaultForTest(vault, nil, defaults, 0, "test")
			defer c.Close()

			for i, q := range queries {
				want := results[i].(map[string]any)
				gotVal, gotOK := c.Get(q)
				wantVal := want["value"]
				if wantVal == nil {
					if gotOK {
						t.Fatalf("%s: Get(%q) = (%q, true), want (_, false)", v.Name, q, gotVal)
					}
				} else if !gotOK || gotVal != wantVal.(string) {
					t.Fatalf("%s: Get(%q) = (%q, %v), want %q", v.Name, q, gotVal, gotOK, wantVal)
				}
				if string(c.Source(q)) != want["source"].(string) {
					t.Fatalf("%s: Source(%q) = %s, want %s", v.Name, q, c.Source(q), want["source"])
				}
				if c.Has(q) != want["has"].(bool) {
					t.Fatalf("%s: Has(%q) = %v, want %v", v.Name, q, c.Has(q), want["has"])
				}
			}
		})
	}
}

func TestConformanceAssetPath(t *testing.T) {
	root := corpusRoot(t)
	for _, v := range loadCategory(t, root, "asset-path") {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			if v.BinBytes == nil {
				t.Fatalf(".bin required")
			}
			in := v.inputs()
			key, _ := in["key"].(string)
			c := fromVaultForTest(nil, map[string][]byte{key: v.BinBytes}, nil, 0, "test")

			gotBytes, err := c.AssetBytes(key)
			if err != nil {
				c.Close()
				t.Fatalf("AssetBytes: %v", err)
			}
			exp := v.Meta["expected"].(map[string]any)
			wantHex, _ := exp["bytes_hex"].(string)
			if got := hex.EncodeToString(gotBytes); got != wantHex {
				c.Close()
				t.Fatalf("AssetBytes hex mismatch: %s vs %s", got, wantHex)
			}
			path, err := c.AssetPath(key)
			if err != nil {
				c.Close()
				t.Fatalf("AssetPath: %v", err)
			}
			data, _ := os.ReadFile(path)
			if hex.EncodeToString(data) != wantHex {
				c.Close()
				t.Fatalf("on-disk bytes mismatch")
			}
			st, err := os.Stat(path)
			if err != nil {
				c.Close()
				t.Fatalf("stat: %v", err)
			}
			if mode := st.Mode().Perm(); mode != 0o600 {
				c.Close()
				t.Fatalf("mode = %o, want 0o600", mode)
			}
			c.Close()
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("tempfile should be unlinked after Close")
			}
		})
	}
}

func TestConformanceErrorTaxonomy(t *testing.T) {
	root := corpusRoot(t)
	for _, v := range loadCategory(t, root, "error-taxonomy") {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			expectedErr := v.expectedError()
			if expectedErr == "" {
				t.Fatalf("%s: error-taxonomy vectors must declare expected.error", v.Name)
			}
			switch v.Name {
			case "config-missing":
				_, _, err := ResolveBootstrapInputsFromMap(map[string]string{})
				assertErrorName(t, v, err)
				return
			case "s3-unreachable":
				// Drive via Open with an injected fetcher that fails.
				ranOpen(t, v, &fakeFetcher{err: ErrS3Unreachable})
				return
			case "manifest-not-found":
				ranOpen(t, v, &fakeFetcher{err: ErrManifestNotFound})
				return
			case "config-unsupported-version":
				if v.BinBytes == nil {
					t.Fatalf(".bin required")
				}
				_, err := DecodeConfigBlob(v.BinBytes)
				assertErrorName(t, v, err)
				return
			case "wrong-passphrase", "bundle-corrupt", "unsupported-spec-version":
				if v.BinBytes == nil {
					t.Fatalf(".bin required")
				}
				in := v.inputs()
				pp, _ := in["passphrase"].(string)
				salt, _ := in["salt"].(string)
				_, err := DecryptRQE1(v.BinBytes, pp, salt, 600_000)
				assertErrorName(t, v, err)
				return
			default:
				t.Fatalf("error-taxonomy dispatch missing branch for %q", v.Name)
			}
		})
	}
}

// ranOpen drives an Open() call with a fake fetcher and a minimal
// VSYNC_CONFIG that decodes cleanly — so the test exercises only the
// fetcher-error branch.
func ranOpen(t *testing.T, v vector, f *fakeFetcher) {
	t.Helper()
	cfgBlob := makeConfigBlobForTest(t, "AAAAAAAAAAAAAAAA", 600_000)
	t.Setenv("VSYNC_CONFIG", string(cfgBlob))
	t.Setenv("VSYNC_PASSPHRASE", "pp")
	_, err := Open(context.Background(), WithFetcher(f))
	assertErrorName(t, v, err)
}

func stringMap(m any) map[string]string {
	out := map[string]string{}
	if mm, ok := m.(map[string]any); ok {
		for k, v := range mm {
			if s, ok := v.(string); ok {
				out[k] = s
			}
		}
	}
	return out
}

func stringSlice(s any) []string {
	out := []string{}
	if ss, ok := s.([]any); ok {
		for _, v := range ss {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
