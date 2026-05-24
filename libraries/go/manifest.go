package vsync

import "fmt"

// RQEM0001 manifest pointer-seal — read path only (v0.2 §3, v0.4):
//
//	bytes 0..7    magic "RQEM0001"
//	bytes 8..22   15-char ASCII timestamp "YYYYMMDD-HHmmss"
//	bytes 23..N   payload (opaque)
//
// VerifyManifestAgainstRemoteTS is the load-bearing anti-rollback check —
// an attacker with bucket-write but no key can't quietly swing the
// manifest pointer at a renamed older bundle because the embedded ts won't
// match the URL/key the lib fetched it from.

var rqem0001Magic = []byte{'R', 'Q', 'E', 'M', '0', '0', '0', '1'}

const (
	rqem0001MagicLen  = 8
	rqem0001TSLen     = 15
	rqem0001HeaderLen = rqem0001MagicLen + rqem0001TSLen // 23
)

// UnwrapRQEM0001 parses the envelope and returns (ts, payload). Does NOT
// verify against a remote ts — see VerifyManifestAgainstRemoteTS for that.
func UnwrapRQEM0001(blob []byte) (string, []byte, error) {
	if len(blob) < rqem0001HeaderLen {
		return "", nil, fmt.Errorf("%w: RQEM0001 manifest too short (%d bytes < %d)",
			ErrBundleCorrupt, len(blob), rqem0001HeaderLen)
	}
	if !equalBytes(blob[:rqem0001MagicLen], rqem0001Magic) {
		return "", nil, fmt.Errorf("%w: RQEM0001 magic prefix mismatch", ErrBundleCorrupt)
	}
	tsBytes := blob[rqem0001MagicLen:rqem0001HeaderLen]
	for _, c := range tsBytes {
		if c > 0x7f {
			return "", nil, fmt.Errorf("%w: RQEM0001 timestamp is not ASCII", ErrBundleCorrupt)
		}
	}
	ts := string(tsBytes)
	payload := blob[rqem0001HeaderLen:]
	return ts, payload, nil
}

// VerifyManifestAgainstRemoteTS unwraps and confirms the embedded ts matches
// remoteTS — i.e., the bucket-side object key the manifest was fetched from.
func VerifyManifestAgainstRemoteTS(blob []byte, remoteTS string) (string, []byte, error) {
	ts, payload, err := UnwrapRQEM0001(blob)
	if err != nil {
		return "", nil, err
	}
	if ts != remoteTS {
		return "", nil, fmt.Errorf("%w: RQEM0001 embedded ts %q != remote ts %q — possible rollback or torn write",
			ErrBundleCorrupt, ts, remoteTS)
	}
	return ts, payload, nil
}

// wrapManifestForTest mints a manifest for the unit suite. Production
// callers never write manifests — the CLI is the canonical writer.
func wrapManifestForTest(ts string, payload []byte) []byte {
	out := make([]byte, 0, rqem0001HeaderLen+len(payload))
	out = append(out, rqem0001Magic...)
	tsBytes := []byte(ts)
	if len(tsBytes) != rqem0001TSLen {
		// Pad / truncate so tests that pass weird strings still produce
		// well-framed output and the unwrap path exercises real bytes.
		buf := make([]byte, rqem0001TSLen)
		copy(buf, tsBytes)
		tsBytes = buf
	}
	out = append(out, tsBytes...)
	out = append(out, payload...)
	return out
}
