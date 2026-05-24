package io.github.muthuishere.vsync.s3client.crypto;

import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * RQEM0001 manifest pointer-seal — read path only.
 *
 * <p>The CLI writes manifests as part of push / rotate-passphrase. This
 * library only reads them. Layout (v0.2 §3):
 * <pre>
 *     bytes 0..7    magic "RQEM0001"
 *     bytes 8..22   15-char ASCII timestamp "YYYYMMDD-HHmmss"
 *     bytes 23..N   payload (opaque)
 * </pre>
 *
 * <p>{@link #verifyAgainstRemoteTs} is the load-bearing anti-rollback check —
 * an attacker with bucket-write but no key who renames an older bundle and
 * swings the manifest pointer at it loses this comparison.
 */
public final class Rqem0001 {

    private static final byte[] MAGIC = {'R', 'Q', 'E', 'M', '0', '0', '0', '1'};
    private static final int TS_LEN = 15;
    private static final int HEADER_LEN = MAGIC.length + TS_LEN; // 23

    private Rqem0001() {
    }

    public record Result(String timestamp, byte[] payload) {
    }

    public static Result unwrap(byte[] blob) {
        if (blob == null) {
            throw new BundleCorruptException("RQEM0001 manifest: null bytes");
        }
        if (blob.length < HEADER_LEN) {
            throw new BundleCorruptException(
                    "RQEM0001 manifest too short: " + blob.length + " bytes "
                            + "(need at least " + HEADER_LEN + ")");
        }
        for (int i = 0; i < MAGIC.length; i++) {
            if (blob[i] != MAGIC[i]) {
                throw new BundleCorruptException(
                        "RQEM0001 manifest: magic prefix mismatch — not a vsync manifest");
            }
        }
        byte[] tsBytes = Arrays.copyOfRange(blob, MAGIC.length, HEADER_LEN);
        for (byte b : tsBytes) {
            if ((b & 0xff) > 0x7f) {
                throw new BundleCorruptException(
                        "RQEM0001 manifest: timestamp is not ASCII");
            }
        }
        String ts = new String(tsBytes, StandardCharsets.US_ASCII);
        byte[] payload = Arrays.copyOfRange(blob, HEADER_LEN, blob.length);
        return new Result(ts, payload);
    }

    public static Result verifyAgainstRemoteTs(byte[] blob, String remoteTs) {
        Result r = unwrap(blob);
        if (!r.timestamp().equals(remoteTs)) {
            throw new BundleCorruptException(
                    "RQEM0001 manifest: embedded ts " + r.timestamp()
                            + " != remote ts " + remoteTs
                            + " — possible pointer-rollback attack or torn bucket write");
        }
        return r;
    }
}
