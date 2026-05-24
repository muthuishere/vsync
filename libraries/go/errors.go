// Package vsync is the Go port of vsync-s3-client.
//
// Spec: docs/specs/v0.12-vsync-s3-client.md. The CLI (`@muthuishere/vsync`)
// is the canonical writer; this library is the read-side runtime. One
// process-input pair (`VSYNC_CONFIG` + `VSYNC_PASSPHRASE`), one S3 round
// trip on Open, in-memory accessor with a deterministic fallback chain.
//
// Errors are the seven canonical sentinel values declared in this file.
// Match them with errors.Is — the conformance corpus pins error class
// identity, and errors.Is is how Go libs honor that contract (v0.12 §11,
// v0.11 §5).
package vsync

import "errors"

// Canonical error sentinels. Names match v0.12 §11 exactly; the spelling
// drift (Python `ConfigMissingError` vs Go `ErrConfigMissing`) is per-
// language idiom — CanonicalName maps Go → canonical.
var (
	ErrConfigMissing            = errors.New("vsync: config missing")
	ErrConfigUnsupportedVersion = errors.New("vsync: config version unsupported")
	ErrS3Unreachable            = errors.New("vsync: s3 unreachable")
	ErrManifestNotFound         = errors.New("vsync: manifest not found")
	ErrWrongPassphrase          = errors.New("vsync: wrong passphrase")
	ErrBundleCorrupt            = errors.New("vsync: bundle corrupt")
	ErrUnsupportedSpecVersion   = errors.New("vsync: unsupported spec version")
)

// canonicalNames maps each sentinel to the cross-language class name the
// conformance corpus pins (v0.12 §11, v0.11 §5).
var canonicalNames = map[error]string{
	ErrConfigMissing:            "ConfigMissingError",
	ErrConfigUnsupportedVersion: "ConfigUnsupportedVersionError",
	ErrS3Unreachable:            "S3UnreachableError",
	ErrManifestNotFound:         "ManifestNotFoundError",
	ErrWrongPassphrase:          "WrongPassphraseError",
	ErrBundleCorrupt:            "BundleCorruptError",
	ErrUnsupportedSpecVersion:   "UnsupportedSpecVersionError",
}

// CanonicalName returns the cross-language taxonomy name for err, or "" if
// err doesn't wrap any vsync sentinel. Used by the conformance loader to
// compare against the corpus's `expected.error` field.
func CanonicalName(err error) string {
	if err == nil {
		return ""
	}
	for sentinel, name := range canonicalNames {
		if errors.Is(err, sentinel) {
			return name
		}
	}
	return ""
}
