package io.github.muthuishere.vsync.s3client.crypto;

import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class Rqem0001Test {

    private static byte[] mintManifest(String ts, byte[] payload) {
        byte[] magic = {'R', 'Q', 'E', 'M', '0', '0', '0', '1'};
        byte[] tsBytes = ts.getBytes(StandardCharsets.US_ASCII);
        byte[] out = new byte[magic.length + 15 + payload.length];
        System.arraycopy(magic, 0, out, 0, magic.length);
        System.arraycopy(tsBytes, 0, out, magic.length, Math.min(15, tsBytes.length));
        System.arraycopy(payload, 0, out, magic.length + 15, payload.length);
        return out;
    }

    @Test
    void unwrapsValidManifest() {
        byte[] payload = {1, 2, 3, 4};
        byte[] envelope = mintManifest("20260101-120000", payload);
        Rqem0001.Result r = Rqem0001.unwrap(envelope);
        assertEquals("20260101-120000", r.timestamp());
        assertArrayEquals(payload, r.payload());
    }

    @Test
    void tooShortThrowsBundleCorrupt() {
        assertThrows(BundleCorruptException.class,
                () -> Rqem0001.unwrap(new byte[22]));
    }

    @Test
    void wrongMagicThrowsBundleCorrupt() {
        byte[] envelope = mintManifest("20260101-120000", new byte[0]);
        envelope[0] = 'X';
        assertThrows(BundleCorruptException.class,
                () -> Rqem0001.unwrap(envelope));
    }

    @Test
    void nonAsciiTimestampThrowsBundleCorrupt() {
        byte[] envelope = mintManifest("20260101-120000", new byte[0]);
        envelope[8] = (byte) 0xff;
        assertThrows(BundleCorruptException.class,
                () -> Rqem0001.unwrap(envelope));
    }

    @Test
    void verifyAgainstMatchingRemoteTsPasses() {
        byte[] envelope = mintManifest("20260101-120000", new byte[]{9, 9});
        Rqem0001.Result r = Rqem0001.verifyAgainstRemoteTs(envelope, "20260101-120000");
        assertEquals("20260101-120000", r.timestamp());
        assertArrayEquals(new byte[]{9, 9}, r.payload());
    }

    @Test
    void verifyAgainstMismatchedRemoteTsThrowsBundleCorrupt() {
        byte[] envelope = mintManifest("20260101-120000", new byte[0]);
        assertThrows(BundleCorruptException.class,
                () -> Rqem0001.verifyAgainstRemoteTs(envelope, "20260101-130000"));
    }
}
