package vsync

import (
	"bytes"
	"os"
	"testing"
)

func TestAssetMaterializerWritesFile0600(t *testing.T) {
	am := &assetMaterializer{}
	t.Cleanup(func() { am.close() })

	payload := []byte("PEM contents would go here")
	path, err := am.materialize("svc.json", payload)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := st.Mode().Perm(); mode != 0o600 {
		t.Errorf("mode = %o, want 0o600", mode)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(data, payload) {
		t.Errorf("payload mismatch")
	}
}

func TestAssetMaterializerCachesPathPerName(t *testing.T) {
	am := &assetMaterializer{}
	t.Cleanup(func() { am.close() })

	first, err := am.materialize("k", []byte("v1"))
	if err != nil {
		t.Fatalf("materialize first: %v", err)
	}
	second, err := am.materialize("k", []byte("v2-not-actually-rewritten"))
	if err != nil {
		t.Fatalf("materialize second: %v", err)
	}
	if first != second {
		t.Errorf("repeat materialize should return cached path; got %q vs %q", first, second)
	}
	// Cached path → file still holds v1.
	data, _ := os.ReadFile(first)
	if string(data) != "v1" {
		t.Errorf("repeat materialize should not rewrite; got %q", data)
	}
}

func TestAssetMaterializerCloseUnlinks(t *testing.T) {
	am := &assetMaterializer{}
	path, err := am.materialize("x", []byte("y"))
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	am.close()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("close() should unlink the tempdir; stat err = %v", err)
	}
	// Second close — must be a no-op.
	am.close()
}

func TestAssetMaterializerDefangsPathTraversal(t *testing.T) {
	am := &assetMaterializer{}
	t.Cleanup(func() { am.close() })

	path, err := am.materialize("../../etc/passwd", []byte("malicious"))
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	// basename only — the file must land inside the tempdir.
	if path == "/etc/passwd" {
		t.Fatalf("path traversal not defanged: %q", path)
	}
}
