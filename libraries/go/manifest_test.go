package vsync

import (
	"bytes"
	"errors"
	"testing"
)

func TestUnwrapRQEM0001RoundTrip(t *testing.T) {
	ts := "20260429-103045"
	payload := []byte("hello world")
	blob := wrapManifestForTest(ts, payload)
	gotTS, gotPayload, err := UnwrapRQEM0001(blob)
	if err != nil {
		t.Fatalf("unwrap: %v", err)
	}
	if gotTS != ts {
		t.Fatalf("ts: got %q want %q", gotTS, ts)
	}
	if !bytes.Equal(gotPayload, payload) {
		t.Fatalf("payload mismatch")
	}
}

func TestUnwrapRQEM0001RejectsShort(t *testing.T) {
	_, _, err := UnwrapRQEM0001([]byte{0, 1, 2})
	if !errors.Is(err, ErrBundleCorrupt) {
		t.Fatalf("expected ErrBundleCorrupt, got %v", err)
	}
}

func TestUnwrapRQEM0001RejectsWrongMagic(t *testing.T) {
	bad := make([]byte, 30)
	copy(bad, []byte("XQEM0001"))
	_, _, err := UnwrapRQEM0001(bad)
	if !errors.Is(err, ErrBundleCorrupt) {
		t.Fatalf("expected ErrBundleCorrupt, got %v", err)
	}
}

func TestVerifyAgainstRemoteTSMismatch(t *testing.T) {
	blob := wrapManifestForTest("20260429-103045", []byte("p"))
	_, _, err := VerifyManifestAgainstRemoteTS(blob, "20260501-091500")
	if !errors.Is(err, ErrBundleCorrupt) {
		t.Fatalf("expected ErrBundleCorrupt on ts mismatch, got %v", err)
	}
}

func TestVerifyAgainstRemoteTSMatch(t *testing.T) {
	ts := "20260429-103045"
	payload := []byte("p")
	blob := wrapManifestForTest(ts, payload)
	gotTS, gotPayload, err := VerifyManifestAgainstRemoteTS(blob, ts)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if gotTS != ts || !bytes.Equal(gotPayload, payload) {
		t.Fatalf("verify roundtrip mismatch")
	}
}
