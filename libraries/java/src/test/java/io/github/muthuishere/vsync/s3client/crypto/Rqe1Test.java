package io.github.muthuishere.vsync.s3client.crypto;

import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;
import io.github.muthuishere.vsync.s3client.exceptions.UnsupportedSpecVersionException;
import io.github.muthuishere.vsync.s3client.exceptions.WrongPassphraseException;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class Rqe1Test {

    private static final String PASSPHRASE = "correct horse battery staple";
    private static final String SALT = "test-salt-1234567890";

    @Test
    void roundTripsHelloWorld() {
        byte[] plaintext = "hello world".getBytes(StandardCharsets.UTF_8);
        byte[] envelope = Rqe1.encryptForTest(plaintext, PASSPHRASE, SALT, 1000);
        byte[] decrypted = Rqe1.decrypt(envelope, PASSPHRASE, SALT, 1000);
        assertArrayEquals(plaintext, decrypted);
    }

    @Test
    void roundTripsEmptyPlaintext() {
        byte[] envelope = Rqe1.encryptForTest(new byte[0], PASSPHRASE, SALT, 1000);
        // Empty plaintext envelope is at the structural floor: magic(4) + IV(12) + tag(16) = 32.
        assertEquals(32, envelope.length);
        assertArrayEquals(new byte[0], Rqe1.decrypt(envelope, PASSPHRASE, SALT, 1000));
    }

    @Test
    void wrongPassphraseThrowsWrongPassphraseException() {
        byte[] envelope = Rqe1.encryptForTest("data".getBytes(), PASSPHRASE, SALT, 1000);
        assertThrows(WrongPassphraseException.class,
                () -> Rqe1.decrypt(envelope, "wrong-passphrase", SALT, 1000));
    }

    @Test
    void tooShortThrowsBundleCorrupt() {
        // Anything shorter than 32 bytes (magic + IV + tag) is structurally invalid.
        assertThrows(BundleCorruptException.class,
                () -> Rqe1.decrypt(new byte[31], PASSPHRASE, SALT, 1000));
        assertThrows(BundleCorruptException.class,
                () -> Rqe1.decrypt(new byte[0], PASSPHRASE, SALT, 1000));
    }

    @Test
    void wrongMagicThrowsBundleCorrupt() {
        byte[] envelope = Rqe1.encryptForTest("data".getBytes(), PASSPHRASE, SALT, 1000);
        envelope[0] = 'X';
        assertThrows(BundleCorruptException.class,
                () -> Rqe1.decrypt(envelope, PASSPHRASE, SALT, 1000));
    }

    @Test
    void wrongVersionByteThrowsUnsupportedSpecVersion() {
        byte[] envelope = Rqe1.encryptForTest("data".getBytes(), PASSPHRASE, SALT, 1000);
        // Magic prefix "RQE" matches but version byte flipped to '2'.
        envelope[3] = '2';
        assertThrows(UnsupportedSpecVersionException.class,
                () -> Rqe1.decrypt(envelope, PASSPHRASE, SALT, 1000));
    }

    @Test
    void tamperedCiphertextThrowsWrongPassphrase() {
        byte[] envelope = Rqe1.encryptForTest("data".getBytes(), PASSPHRASE, SALT, 1000);
        // Flip a bit in the ciphertext — AES-GCM tag rejects.
        envelope[envelope.length - 1] ^= (byte) 0x01;
        assertThrows(WrongPassphraseException.class,
                () -> Rqe1.decrypt(envelope, PASSPHRASE, SALT, 1000));
    }

    @Test
    void saltAsBytesAndAsStringAreEquivalent() {
        // Convention A (v0.12 §2.1): salt string is fed to PBKDF2 as UTF-8 bytes verbatim.
        byte[] envelope = Rqe1.encryptForTest("x".getBytes(), PASSPHRASE, SALT, 100);
        byte[] viaString = Rqe1.decrypt(envelope, PASSPHRASE, SALT, 100);
        byte[] viaBytes = Rqe1.decrypt(envelope, PASSPHRASE,
                SALT.getBytes(StandardCharsets.UTF_8), 100);
        assertArrayEquals(viaString, viaBytes);
    }

    @Test
    void structuralFloorIs32NotLarger() {
        // Sanity: the team-lead's brief was explicit — 32 (magic+IV+tag), NOT 48.
        // A 32-byte input that's actually a valid (empty-plaintext) envelope decrypts;
        // anything strictly shorter is structural corrupt.
        byte[] envelope = Rqe1.encryptForTest(new byte[0], PASSPHRASE, SALT, 100);
        assertEquals(32, envelope.length);
        // Truncate by one byte → BundleCorrupt (structural).
        byte[] short31 = Arrays.copyOf(envelope, 31);
        assertThrows(BundleCorruptException.class,
                () -> Rqe1.decrypt(short31, PASSPHRASE, SALT, 100));
    }
}
