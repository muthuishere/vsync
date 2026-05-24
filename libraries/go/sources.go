package vsync

import (
	"bytes"
	"fmt"
	"os"
	"runtime"
)

// Bootstrap input names (v0.12 §2). `_FILE` wins if both forms are set;
// env-direct is verbatim; file form has trailing whitespace stripped.
const (
	envConfig         = "VSYNC_CONFIG"
	envConfigFile     = "VSYNC_CONFIG_FILE"
	envPassphrase     = "VSYNC_PASSPHRASE"
	envPassphraseFile = "VSYNC_PASSPHRASE_FILE"
)

// ResolveBootstrapInputs reads from the process environment.
// (Production entry point; tests use ResolveBootstrapInputsFromMap.)
func ResolveBootstrapInputs() ([]byte, string, error) {
	env := make(map[string]string)
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				env[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	return ResolveBootstrapInputsFromMap(env)
}

// ResolveBootstrapInputsFromMap is the table-driven variant the test suite
// uses. Same precedence rules as ResolveBootstrapInputs.
func ResolveBootstrapInputsFromMap(env map[string]string) ([]byte, string, error) {
	cfg, err := resolveOne(env, envConfig, envConfigFile)
	if err != nil {
		return nil, "", err
	}
	if cfg == nil {
		return nil, "", fmt.Errorf("%w: neither %s nor %s is set",
			ErrConfigMissing, envConfig, envConfigFile)
	}
	pp, err := resolveOne(env, envPassphrase, envPassphraseFile)
	if err != nil {
		return nil, "", err
	}
	if pp == nil {
		return nil, "", fmt.Errorf("%w: neither %s nor %s is set",
			ErrConfigMissing, envPassphrase, envPassphraseFile)
	}
	return cfg, string(pp), nil
}

// resolveOne implements the _FILE-wins rule for a single (envName, fileName)
// pair. Returns (nil, nil) if neither is set so the caller can decide which
// missing-var message to emit.
func resolveOne(env map[string]string, envName, fileName string) ([]byte, error) {
	if path, ok := env[fileName]; ok && path != "" {
		return readPolicyChecked(path)
	}
	if val, ok := env[envName]; ok {
		// Env-direct: take verbatim, no trim — a leading space in a
		// passphrase is part of the passphrase (v0.12 §2).
		return []byte(val), nil
	}
	return nil, nil
}

// readPolicyChecked applies the v0.12 §13 file-permissions policy and
// returns the stripped content. 0666/0777 → refuse. 0644/0640 → warn but
// allow. ENOENT/EACCES → ErrConfigMissing with a hint.
func readPolicyChecked(path string) ([]byte, error) {
	if runtime.GOOS != "windows" {
		st, err := os.Stat(path)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, fmt.Errorf("%w: %s does not exist — fix the deploy config",
					ErrConfigMissing, path)
			}
			if os.IsPermission(err) {
				return nil, fmt.Errorf("%w: cannot stat %s: permission denied",
					ErrConfigMissing, path)
			}
			return nil, fmt.Errorf("%w: cannot stat %s: %v", ErrConfigMissing, path, err)
		}
		mode := st.Mode().Perm()
		if mode&0o002 != 0 {
			// World-writable — refuse rather than read a file that anyone
			// on the box can rewrite under our feet.
			return nil, fmt.Errorf("%w: refusing to read world-writable file %s (mode %o); narrow to 0600",
				ErrConfigMissing, path, mode)
		}
		if mode&0o044 != 0 {
			// Group/world readable — surface on stderr, still read.
			fmt.Fprintf(os.Stderr, "vsync: %s is world/group-readable (mode %o); narrow to 0600\n",
				path, mode)
		}
	} else {
		fmt.Fprintln(os.Stderr, "vsync: file-permission check skipped (Windows)")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s does not exist", ErrConfigMissing, path)
		}
		if os.IsPermission(err) {
			return nil, fmt.Errorf("%w: cannot read %s: permission denied", ErrConfigMissing, path)
		}
		return nil, fmt.Errorf("%w: read %s: %v", ErrConfigMissing, path, err)
	}
	// Strip trailing whitespace per v0.12 §2 (CRLF, LF, tab, space).
	return bytes.TrimRight(data, "\r\n\t "), nil
}
