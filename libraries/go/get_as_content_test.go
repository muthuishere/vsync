package vsync

import (
	"bytes"
	"testing"
)

func TestGetAsContentReturnsAssetBytes(t *testing.T) {
	bin := []byte{0x00, 0x01, 0x02, 0xff}
	c := fromVaultForTest(nil, map[string][]byte{"key.pem": bin}, nil, 0, "test")
	defer c.Close()

	got, err := c.GetAsContent("key.pem")
	if err != nil {
		t.Fatalf("GetAsContent: %v", err)
	}
	if !bytes.Equal(got, bin) {
		t.Errorf("bytes mismatch: got %v, want %v", got, bin)
	}
}

func TestGetAsContentMissingErrors(t *testing.T) {
	c := fromVaultForTest(nil, nil, nil, 0, "test")
	defer c.Close()
	if _, err := c.GetAsContent("nope"); err == nil {
		t.Errorf("missing asset should error")
	}
}

func TestGetAsContentFallsThroughKVForBinaryAsString(t *testing.T) {
	// The asset-path conformance vectors store the binary value as the .bin
	// seeded into assets; some shapes seed KV instead and ask for the
	// content via the asset accessor. Mirror Python's fallthrough.
	c := fromVaultForTest(map[string]string{"only-kv": "value-as-string"}, nil, nil, 0, "t")
	defer c.Close()
	got, err := c.GetAsContent("only-kv")
	if err != nil {
		t.Fatalf("KV fallthrough: %v", err)
	}
	if string(got) != "value-as-string" {
		t.Errorf("KV fallthrough returned %q", got)
	}
}

func TestGetAsContentReturnsCopyNotInternalReference(t *testing.T) {
	bin := []byte{0xa, 0xb, 0xc}
	c := fromVaultForTest(nil, map[string][]byte{"k": bin}, nil, 0, "t")
	defer c.Close()

	got, err := c.GetAsContent("k")
	if err != nil {
		t.Fatalf("GetAsContent: %v", err)
	}
	// Mutate the returned slice; ask again; the second copy must be intact.
	got[0] = 0xff
	again, _ := c.GetAsContent("k")
	if again[0] != 0xa {
		t.Errorf("GetAsContent leaked internal reference; second call returned mutated bytes %v", again)
	}
}

func TestGetAsContentOnClosedHandleErrors(t *testing.T) {
	c := fromVaultForTest(nil, map[string][]byte{"k": []byte("v")}, nil, 0, "t")
	c.Close()
	if _, err := c.GetAsContent("k"); err == nil {
		t.Errorf("GetAsContent on closed handle should error")
	}
}
