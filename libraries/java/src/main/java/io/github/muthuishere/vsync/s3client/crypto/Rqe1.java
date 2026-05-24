package io.github.muthuishere.vsync.s3client.crypto;

import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;
import io.github.muthuishere.vsync.s3client.exceptions.UnsupportedSpecVersionException;
import io.github.muthuishere.vsync.s3client.exceptions.WrongPassphraseException;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.spec.KeySpec;
import java.util.Arrays;

/**
 * RQE1 envelope — decrypt path only.
 *
 * <p>The CLI ({@code @muthuishere/vsync}) is the canonical writer; this library
 * is the reader. {@link #encryptForTest} exists so the unit suite has a
 * round-trip fixture independent of the test-vector corpus — production
 * callers must never reuse it.
 *
 * <p>Layout (mirrors {@code src/crypto.ts}):
 * <pre>
 *     bytes 0..3    magic "RQE1"
 *     bytes 4..15   12-byte IV
 *     bytes 16..N   ciphertext || 16-byte AES-GCM auth tag
 * </pre>
 *
 * <p>KDF: PBKDF2-HMAC-SHA256 → 32-byte AES-256 key. Default iterations are
 * 600,000 (matches v0.2 spec); the caller passes the iteration count
 * explicitly so the conformance corpus can mint vectors with any work
 * factor the CLI happens to use.
 *
 * <p>Salt convention A (v0.12 §2.1, locked at bc52f51): the salt string is
 * fed to PBKDF2 as its UTF-8 bytes VERBATIM — do NOT base64-decode first,
 * even if the bytes happen to look base64-shaped. The byte-flavored
 * {@link #decrypt(byte[], String, byte[], int)} entry point is symmetric
 * for callers who already have raw salt bytes.
 */
public final class Rqe1 {

    private static final byte[] MAGIC_PREFIX = {'R', 'Q', 'E'};
    private static final byte MAGIC_VERSION = '1';
    private static final int IV_LEN = 12;
    private static final int HEADER_LEN = MAGIC_PREFIX.length + 1 + IV_LEN; // 16
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_TAG_BYTES = GCM_TAG_BITS / 8; // 16

    /**
     * Structural floor: header + GCM tag. A valid empty-plaintext envelope is
     * exactly this length; anything shorter is mid-payload truncation and we
     * surface it as {@link BundleCorruptException} rather than letting
     * AES-GCM raise the ambiguous {@code AEADBadTagException} (which we'd
     * have to surface as {@link WrongPassphraseException}). Cross-language
     * consistency with Python / Go / TS — all three use 32 here.
     */
    private static final int MIN_ENVELOPE_LEN = HEADER_LEN + GCM_TAG_BYTES; // 32

    private static final int KEY_LEN_BITS = 256;
    public static final int DEFAULT_ITERATIONS = 600_000;

    private Rqe1() {
    }

    public static byte[] decrypt(byte[] envelope, String passphrase, String salt, int iterations) {
        return decrypt(envelope, passphrase, salt.getBytes(StandardCharsets.UTF_8), iterations);
    }

    public static byte[] decrypt(byte[] envelope, String passphrase, byte[] salt, int iterations) {
        if (envelope == null) {
            throw new BundleCorruptException("RQE1 envelope: null bytes");
        }
        if (envelope.length < MIN_ENVELOPE_LEN) {
            throw new BundleCorruptException(
                    "RQE1 envelope structurally too short: " + envelope.length
                            + " bytes (need at least " + MIN_ENVELOPE_LEN + ")");
        }
        // Split the 4-byte magic into prefix + version so wrong-version is
        // reported as UnsupportedSpecVersion (v0.12 §11) rather than corrupt.
        for (int i = 0; i < MAGIC_PREFIX.length; i++) {
            if (envelope[i] != MAGIC_PREFIX[i]) {
                throw new BundleCorruptException(
                        "RQE1 envelope: magic prefix is not 'RQE' — not a vsync envelope");
            }
        }
        if (envelope[3] != MAGIC_VERSION) {
            throw new UnsupportedSpecVersionException(
                    "RQE envelope advertises version 0x"
                            + Integer.toHexString(envelope[3] & 0xff)
                            + "; this library understands '1' only — upgrade vsync-s3-client");
        }

        byte[] iv = Arrays.copyOfRange(envelope, MAGIC_PREFIX.length + 1, HEADER_LEN);
        byte[] ciphertext = Arrays.copyOfRange(envelope, HEADER_LEN, envelope.length);
        byte[] keyBytes = deriveKey(passphrase, salt, iterations);
        try {
            SecretKey key = new SecretKeySpec(keyBytes, "AES");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            return cipher.doFinal(ciphertext);
        } catch (javax.crypto.AEADBadTagException e) {
            throw new WrongPassphraseException(
                    "RQE1 envelope: AES-GCM tag rejected — passphrase is wrong "
                            + "or the ciphertext has been tampered with", e);
        } catch (javax.crypto.BadPaddingException e) {
            // Older JCE providers surface tag failures here instead of AEADBadTag.
            throw new WrongPassphraseException(
                    "RQE1 envelope: AES-GCM tag rejected (BadPadding) — "
                            + "passphrase wrong or ciphertext tampered", e);
        } catch (Exception e) {
            // GeneralSecurityException family — provider configuration / IV /
            // key-length bugs. Treat as bundle-corrupt since the inputs are
            // structurally well-formed by this point.
            throw new BundleCorruptException(
                    "RQE1 envelope: AES-GCM decrypt failed: " + e.getMessage(), e);
        } finally {
            Arrays.fill(keyBytes, (byte) 0);
        }
    }

    /**
     * Mint an RQE1 envelope for the unit suite. Production callers MUST NOT
     * use this — the CLI is the canonical writer (decision B in the v0.9
     * design huddle). Kept here so unit tests can verify decrypt against
     * bytes minted in-process, independent of the corpus.
     */
    public static byte[] encryptForTest(byte[] plaintext, String passphrase, String salt, int iterations) {
        byte[] iv = new byte[IV_LEN];
        new SecureRandom().nextBytes(iv);
        byte[] keyBytes = deriveKey(passphrase, salt.getBytes(StandardCharsets.UTF_8), iterations);
        try {
            SecretKey key = new SecretKeySpec(keyBytes, "AES");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] ct = cipher.doFinal(plaintext);
            byte[] out = new byte[HEADER_LEN + ct.length];
            System.arraycopy(MAGIC_PREFIX, 0, out, 0, MAGIC_PREFIX.length);
            out[MAGIC_PREFIX.length] = MAGIC_VERSION;
            System.arraycopy(iv, 0, out, HEADER_LEN - IV_LEN, IV_LEN);
            System.arraycopy(ct, 0, out, HEADER_LEN, ct.length);
            return out;
        } catch (Exception e) {
            throw new IllegalStateException("encryptForTest failed", e);
        } finally {
            Arrays.fill(keyBytes, (byte) 0);
        }
    }

    private static byte[] deriveKey(String passphrase, byte[] salt, int iterations) {
        try {
            SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            KeySpec spec = new PBEKeySpec(
                    passphrase.toCharArray(), salt, iterations, KEY_LEN_BITS);
            return factory.generateSecret(spec).getEncoded();
        } catch (Exception e) {
            throw new BundleCorruptException("PBKDF2 key derivation failed: " + e.getMessage(), e);
        }
    }
}
