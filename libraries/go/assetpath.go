package vsync

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// assetMaterializer owns a per-handle tempdir and lazily writes each asset
// to a 0600 file inside it (v0.12 §6). Repeat calls with the same name
// return the cached path without rewriting.
//
// SIGKILL does not run close(); on tmpfs the dir clears on reboot, on
// disk-backed /tmp the OS / next sweep cleans it up. We document this in
// the README — we don't promise more than the OS gives us.
type assetMaterializer struct {
	tempdir string
	cache   map[string]string
	closed  bool
}

func (a *assetMaterializer) ensureDir() error {
	if a.tempdir != "" {
		return nil
	}
	// On Linux, prefer /dev/shm so the bytes stay off the platter.
	base := ""
	if runtime.GOOS == "linux" {
		if st, err := os.Stat("/dev/shm"); err == nil && st.IsDir() {
			base = "/dev/shm"
		}
	}
	dir, err := os.MkdirTemp(base, fmt.Sprintf("vsync-%d-", os.Getpid()))
	if err != nil {
		return err
	}
	// MkdirTemp uses 0700 on Unix already; chmod for belt-and-braces in
	// case a non-standard umask interfered.
	if err := os.Chmod(dir, 0o700); err != nil {
		os.RemoveAll(dir)
		return err
	}
	a.tempdir = dir
	a.cache = make(map[string]string)
	return nil
}

func (a *assetMaterializer) materialize(name string, payload []byte) (string, error) {
	if a.closed {
		return "", fmt.Errorf("assetMaterializer: already closed")
	}
	if err := a.ensureDir(); err != nil {
		return "", err
	}
	if existing, ok := a.cache[name]; ok {
		return existing, nil
	}
	// Defang the name: take basename so a malicious "../../etc/passwd"
	// can't escape. The bundle is operator-trusted but containment is
	// the polite default.
	safe := filepath.Base(name)
	if safe == "" || safe == "." || safe == ".." || safe == string(filepath.Separator) {
		safe = "_asset"
	}
	path := filepath.Join(a.tempdir, safe)
	// O_CREATE|O_WRONLY|O_TRUNC with explicit 0600 — umask of the
	// process is irrelevant when we pass the mode to open(2) directly.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(payload); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	// Belt-and-braces re-chmod (some platforms apply umask to open's mode).
	if err := os.Chmod(path, 0o600); err != nil {
		return "", err
	}
	a.cache[name] = path
	return path, nil
}

func (a *assetMaterializer) close() {
	if a.closed {
		return
	}
	a.closed = true
	if a.tempdir != "" {
		os.RemoveAll(a.tempdir)
		a.tempdir = ""
	}
	a.cache = nil
}
