package vsync

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveBootstrapInputsBothEnvVars(t *testing.T) {
	env := map[string]string{
		"VSYNC_CONFIG":     "vsync-cfg-v1:abc",
		"VSYNC_PASSPHRASE": "hunter2",
	}
	cfg, pp, err := ResolveBootstrapInputsFromMap(env)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !bytes.Equal(cfg, []byte("vsync-cfg-v1:abc")) {
		t.Errorf("config blob mismatch")
	}
	if pp != "hunter2" {
		t.Errorf("passphrase mismatch")
	}
}

func TestResolveBootstrapInputsMissingConfigFails(t *testing.T) {
	_, _, err := ResolveBootstrapInputsFromMap(map[string]string{"VSYNC_PASSPHRASE": "p"})
	if !errors.Is(err, ErrConfigMissing) {
		t.Fatalf("expected ErrConfigMissing for missing config, got %v", err)
	}
}

func TestResolveBootstrapInputsMissingPassphraseFails(t *testing.T) {
	_, _, err := ResolveBootstrapInputsFromMap(map[string]string{"VSYNC_CONFIG": "vsync-cfg-v1:x"})
	if !errors.Is(err, ErrConfigMissing) {
		t.Fatalf("expected ErrConfigMissing for missing passphrase, got %v", err)
	}
}

func TestResolveBootstrapInputsFileWinsOverEnv(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "cfg")
	ppPath := filepath.Join(dir, "pp")
	// 0600 — file-mode policy below is happy with owner-only.
	if err := os.WriteFile(cfgPath, []byte("vsync-cfg-v1:from-file\n"), 0o600); err != nil {
		t.Fatalf("write cfg: %v", err)
	}
	if err := os.WriteFile(ppPath, []byte("filepass\n"), 0o600); err != nil {
		t.Fatalf("write pp: %v", err)
	}
	env := map[string]string{
		"VSYNC_CONFIG":          "vsync-cfg-v1:from-env",
		"VSYNC_CONFIG_FILE":     cfgPath,
		"VSYNC_PASSPHRASE":      "envpass",
		"VSYNC_PASSPHRASE_FILE": ppPath,
	}
	cfg, pp, err := ResolveBootstrapInputsFromMap(env)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if string(cfg) != "vsync-cfg-v1:from-file" {
		t.Errorf("config from file should win: got %q", cfg)
	}
	if pp != "filepass" {
		t.Errorf("passphrase from file should win: got %q", pp)
	}
}

func TestResolveBootstrapInputsRefusesWorldWritableFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "cfg")
	if err := os.WriteFile(cfgPath, []byte("vsync-cfg-v1:x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(cfgPath, 0o666); err != nil {
		t.Fatalf("chmod 666: %v", err)
	}
	env := map[string]string{
		"VSYNC_CONFIG_FILE":     cfgPath,
		"VSYNC_PASSPHRASE":      "p",
	}
	_, _, err := ResolveBootstrapInputsFromMap(env)
	if !errors.Is(err, ErrConfigMissing) {
		t.Fatalf("expected ErrConfigMissing for world-writable file, got %v", err)
	}
}

func TestResolveBootstrapInputsStripsTrailingWhitespaceOnFileForm(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "cfg")
	ppPath := filepath.Join(dir, "pp")
	os.WriteFile(cfgPath, []byte("vsync-cfg-v1:body\r\n\t  "), 0o600)
	os.WriteFile(ppPath, []byte("passphrase \n"), 0o600)
	cfg, pp, err := ResolveBootstrapInputsFromMap(map[string]string{
		"VSYNC_CONFIG_FILE":     cfgPath,
		"VSYNC_PASSPHRASE_FILE": ppPath,
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if string(cfg) != "vsync-cfg-v1:body" {
		t.Errorf("file form should strip trailing whitespace; got %q", cfg)
	}
	if pp != "passphrase" {
		t.Errorf("passphrase file form should strip whitespace; got %q", pp)
	}
}
