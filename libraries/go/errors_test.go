package vsync

import (
	"errors"
	"fmt"
	"testing"
)

// The conformance corpus matches errors by canonical class name. Python uses
// type.__name__, TypeScript uses instanceof, Go must use errors.Is against
// these sentinels. CanonicalName maps a sentinel to the spec string.
func TestCanonicalNamesCoverV012(t *testing.T) {
	want := map[string]error{
		"ConfigMissingError":            ErrConfigMissing,
		"ConfigUnsupportedVersionError": ErrConfigUnsupportedVersion,
		"S3UnreachableError":            ErrS3Unreachable,
		"ManifestNotFoundError":         ErrManifestNotFound,
		"WrongPassphraseError":          ErrWrongPassphrase,
		"BundleCorruptError":            ErrBundleCorrupt,
		"UnsupportedSpecVersionError":   ErrUnsupportedSpecVersion,
	}
	for name, sentinel := range want {
		if sentinel == nil {
			t.Fatalf("sentinel for %s is nil", name)
		}
		if got := CanonicalName(sentinel); got != name {
			t.Errorf("CanonicalName(%v) = %q, want %q", sentinel, got, name)
		}
	}
}

func TestSentinelsAreMatchableViaErrorsIs(t *testing.T) {
	// Wrap each sentinel; errors.Is must still match it.
	wrapped := fmt.Errorf("context: %w", ErrWrongPassphrase)
	if !errors.Is(wrapped, ErrWrongPassphrase) {
		t.Fatalf("wrapped ErrWrongPassphrase should match via errors.Is")
	}
	if errors.Is(wrapped, ErrBundleCorrupt) {
		t.Fatalf("wrapped ErrWrongPassphrase must NOT match ErrBundleCorrupt")
	}
}

func TestCanonicalNameUnknownReturnsEmpty(t *testing.T) {
	if got := CanonicalName(errors.New("unrelated")); got != "" {
		t.Fatalf("CanonicalName(unrelated) = %q, want empty", got)
	}
	if got := CanonicalName(nil); got != "" {
		t.Fatalf("CanonicalName(nil) = %q, want empty", got)
	}
}
