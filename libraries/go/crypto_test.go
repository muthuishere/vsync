package vsync

import (
	"bytes"
	"errors"
	"testing"
)

// PBKDF2-SHA256 at 600k iterations runs in well under a second on modern
// hardware. Bundle that with AES-GCM and a few round trips and the file
// stays under 10s total.

func TestDecryptRQE1RejectsShortEnvelope(t *testing.T) {
	// < 48 bytes is structurally impossible — flagged as BundleCorrupt
	// without even attempting key derivation. The conformance corpus
	// uses a 30-byte vector that fires this branch.
	short := make([]byte, 30)
	copy(short, []byte("RQE1"))
	_, err := DecryptRQE1(short, "p", "salt", 600_000)
	if !errors.Is(err, ErrBundleCorrupt) {
		t.Fatalf("expected ErrBundleCorrupt, got %v", err)
	}
}

func TestDecryptRQE1RejectsWrongMagic(t *testing.T) {
	// Long enough to clear the length gate but magic byte 0 is wrong.
	bad := make([]byte, 64)
	copy(bad, []byte("XQE1"))
	_, err := DecryptRQE1(bad, "p", "salt", 600_000)
	if !errors.Is(err, ErrBundleCorrupt) {
		t.Fatalf("expected ErrBundleCorrupt for wrong magic, got %v", err)
	}
}

func TestDecryptRQE1RejectsWrongVersion(t *testing.T) {
	// Magic prefix "RQE" + version "2" → UnsupportedSpecVersion.
	bad := make([]byte, 64)
	copy(bad, []byte("RQE2"))
	_, err := DecryptRQE1(bad, "p", "salt", 600_000)
	if !errors.Is(err, ErrUnsupportedSpecVersion) {
		t.Fatalf("expected ErrUnsupportedSpecVersion, got %v", err)
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	plaintext := []byte("hello world")
	ct, err := encryptRQE1ForTest(plaintext, "passphrase", "salty", 600_000)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	pt, err := DecryptRQE1(ct, "passphrase", "salty", 600_000)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(pt, plaintext) {
		t.Fatalf("round-trip mismatch: got %q want %q", pt, plaintext)
	}
}

func TestDecryptRQE1WrongPassphraseSurfacesWrongPassphraseError(t *testing.T) {
	ct, err := encryptRQE1ForTest([]byte("secret"), "right", "salt", 600_000)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	_, err = DecryptRQE1(ct, "wrong", "salt", 600_000)
	if !errors.Is(err, ErrWrongPassphrase) {
		t.Fatalf("expected ErrWrongPassphrase, got %v", err)
	}
}

func TestDecryptRQE1WithSaltBytes(t *testing.T) {
	// The config-blob path feeds raw salt bytes (decoded from std-base64).
	// Verify the bytes-flavored entry point matches the string flavor when
	// the string is the UTF-8 of the same bytes.
	plaintext := []byte("payload")
	ct, err := encryptRQE1ForTest(plaintext, "pp", "AAAAAAAAAA==", 600_000)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	pt, err := decryptRQE1WithSaltBytes(ct, "pp", []byte("AAAAAAAAAA=="), 600_000)
	if err != nil {
		t.Fatalf("decrypt-bytes: %v", err)
	}
	if !bytes.Equal(pt, plaintext) {
		t.Fatalf("decrypt-bytes mismatch")
	}
}
