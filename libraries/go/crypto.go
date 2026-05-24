package vsync

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"

	"golang.org/x/crypto/pbkdf2"
)

// RQE1 envelope (v0.2 §3):
//
//	bytes 0..3    magic "RQE1"
//	bytes 4..15   12-byte IV
//	bytes 16..N   ciphertext || 16-byte AES-GCM tag
//
// KDF: PBKDF2-HMAC-SHA256 → 32-byte AES-256 key.
const (
	rqe1HeaderLen = 16 // 4-byte magic + 12-byte IV
	rqe1GCMTagLen = 16
	rqe1KeyLen    = 32
	rqe1IVLen     = 12
	// Structural minimum: header (magic + IV) + GCM tag is the smallest a
	// valid envelope can be — that's the empty-plaintext case. Anything
	// shorter is mid-payload truncation we surface as BundleCorrupt rather
	// than letting AES-GCM raise the ambiguous InvalidTag (which we'd have
	// to surface as WrongPassphrase). The conformance corpus's truncated-
	// ciphertext vector is 30 bytes and fires this branch; the empty-
	// plaintext positive vector is exactly 32 bytes and passes through.
	// The team-lead's brief listed 48 (counting salt as part of the
	// envelope) — but salt is a separate PBKDF2 input in the RQE1 wire
	// format, so 32 is the honest floor.
	rqe1MinEnvelope   = rqe1HeaderLen + rqe1GCMTagLen // 32
	defaultPBKDF2Iter = 600_000
)

var (
	rqe1MagicPrefix = []byte{'R', 'Q', 'E'}
	rqe1Version     = byte('1')
)

// DecryptRQE1 decrypts an RQE1 envelope. The salt is the UTF-8 bytes of the
// caller-supplied string (matches the CLI's PBKDF2 path and the conformance
// rqe1-decrypt vectors, which carry salt as a base64-ish ASCII string fed
// to PBKDF2 verbatim).
//
// Error mapping (v0.12 §11):
//   - envelope shorter than rqe1MinEnvelope    → ErrBundleCorrupt
//   - magic prefix "RQE" missing                → ErrBundleCorrupt
//   - magic prefix ok but version byte != '1'   → ErrUnsupportedSpecVersion
//   - GCM tag rejects                           → ErrWrongPassphrase
func DecryptRQE1(envelope []byte, passphrase, salt string, iterations int) ([]byte, error) {
	return decryptRQE1WithSaltBytes(envelope, passphrase, []byte(salt), iterations)
}

// decryptRQE1WithSaltBytes is the byte-flavored entry point used by the
// config-blob path (which decodes a standard-base64 salt field into raw
// bytes). Keeps the runtime call site honest about whether it's feeding
// a string or pre-decoded bytes to PBKDF2.
func decryptRQE1WithSaltBytes(envelope []byte, passphrase string, salt []byte, iterations int) ([]byte, error) {
	// Structural-length gate — see the team-lead's heuristic note:
	// AES-GCM raises the same InvalidTag for "tag flipped" and "ciphertext
	// clipped mid-payload"; the only honest way to disambiguate without an
	// explicit length field is structural. < 48 bytes is impossible for a
	// valid envelope (magic+salt+IV+tag minimum the spec discussions pinned).
	if len(envelope) < rqe1MinEnvelope {
		return nil, fmt.Errorf("%w: RQE1 envelope structurally too short (%d bytes < %d minimum)",
			ErrBundleCorrupt, len(envelope), rqe1MinEnvelope)
	}
	if len(envelope) < rqe1HeaderLen+rqe1GCMTagLen {
		// Defensive — covered by the floor above but explicit for the reader.
		return nil, fmt.Errorf("%w: RQE1 envelope too short for header+tag", ErrBundleCorrupt)
	}
	// Split the 4-byte magic into prefix + version so wrong-version is
	// reported as UnsupportedSpecVersion (v0.12 §11) rather than corrupt.
	if !equalBytes(envelope[:3], rqe1MagicPrefix) {
		return nil, fmt.Errorf("%w: RQE1 magic prefix is not 'RQE'", ErrBundleCorrupt)
	}
	if envelope[3] != rqe1Version {
		return nil, fmt.Errorf("%w: RQE envelope advertises version %q; this library understands '1' only",
			ErrUnsupportedSpecVersion, envelope[3:4])
	}

	iv := envelope[4:rqe1HeaderLen]
	ciphertext := envelope[rqe1HeaderLen:]

	key := pbkdf2.Key([]byte(passphrase), salt, iterations, rqe1KeyLen, sha256.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		// rqe1KeyLen is constant 32 — this can only fail in a broken build.
		return nil, fmt.Errorf("%w: aes init: %v", ErrBundleCorrupt, err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("%w: gcm init: %v", ErrBundleCorrupt, err)
	}
	if len(iv) != gcm.NonceSize() {
		return nil, fmt.Errorf("%w: IV size mismatch", ErrBundleCorrupt)
	}
	pt, err := gcm.Open(nil, iv, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: AES-GCM tag rejected — passphrase wrong or ciphertext tampered (%v)",
			ErrWrongPassphrase, err)
	}
	return pt, nil
}

// encryptRQE1ForTest is unexported — production callers never encrypt; the
// CLI is the canonical writer. The unit suite uses this to mint round-trip
// fixtures independent of docs/specs/test-vectors/.
func encryptRQE1ForTest(plaintext []byte, passphrase, salt string, iterations int) ([]byte, error) {
	iv := make([]byte, rqe1IVLen)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	key := pbkdf2.Key([]byte(passphrase), []byte(salt), iterations, rqe1KeyLen, sha256.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ct := gcm.Seal(nil, iv, plaintext, nil)
	out := make([]byte, 0, rqe1HeaderLen+len(ct))
	out = append(out, rqe1MagicPrefix...)
	out = append(out, rqe1Version)
	out = append(out, iv...)
	out = append(out, ct...)
	return out, nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
