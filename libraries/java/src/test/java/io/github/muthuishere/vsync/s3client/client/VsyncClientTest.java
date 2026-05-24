package io.github.muthuishere.vsync.s3client.client;

import io.github.muthuishere.vsync.s3client.config.VsyncConfig;
import io.github.muthuishere.vsync.s3client.crypto.Rqe1;
import io.github.muthuishere.vsync.s3client.exceptions.ConfigMissingException;
import io.github.muthuishere.vsync.s3client.exceptions.ManifestNotFoundException;
import io.github.muthuishere.vsync.s3client.exceptions.S3UnreachableException;
import io.github.muthuishere.vsync.s3client.exceptions.WrongPassphraseException;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.zip.GZIPOutputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VsyncClientTest {

    private static final String SALT = "abcdefghijklmnopqrstuv";
    private static final String PASSPHRASE = "test-passphrase";
    private static final int ITER = 1000;

    private static byte[] manifest(String ts) {
        byte[] magic = {'R', 'Q', 'E', 'M', '0', '0', '0', '1'};
        byte[] tsBytes = ts.getBytes(StandardCharsets.US_ASCII);
        byte[] out = new byte[magic.length + 15];
        System.arraycopy(magic, 0, out, 0, magic.length);
        System.arraycopy(tsBytes, 0, out, magic.length, Math.min(15, tsBytes.length));
        return out;
    }

    private static byte[] mintConfigBlob() throws Exception {
        String json = "{"
                + "\"v\":1,"
                + "\"endpoint\":\"https://s3.example\","
                + "\"region\":\"us-east-1\","
                + "\"bucket\":\"b\","
                + "\"accessKeyId\":\"k\","
                + "\"secretAccessKey\":\"s\","
                + "\"prefix\":\"myapp/prod/\","
                + "\"env\":\"prod\","
                + "\"salt\":\"" + SALT + "\","
                + "\"iterations\":" + ITER
                + "}";
        ByteArrayOutputStream gz = new ByteArrayOutputStream();
        try (GZIPOutputStream g = new GZIPOutputStream(gz)) {
            g.write(json.getBytes(StandardCharsets.UTF_8));
        }
        String b64 = Base64.getUrlEncoder().withoutPadding().encodeToString(gz.toByteArray());
        return ("vsync-cfg-v1:" + b64).getBytes(StandardCharsets.US_ASCII);
    }

    @Test
    void openWithBootstrapEndToEnd() throws Exception {
        byte[] configBlob = mintConfigBlob();
        byte[] vault = "{\"DATABASE_URL\":\"postgres://round-trip\"}".getBytes();
        byte[] bundle = Rqe1.encryptForTest(vault, PASSPHRASE, SALT, ITER);
        byte[] manifestBytes = manifest("20260101-120000");

        S3Fetcher fakeFetcher = (VsyncConfig cfg) ->
                new S3Fetcher.Fetched(manifestBytes, bundle, 7);

        try (Vsync v = VsyncClient.openWithBootstrap(configBlob, PASSPHRASE,
                new OpenOptions().withFetcher(fakeFetcher))) {
            assertEquals("postgres://round-trip", v.getEnv("DATABASE_URL"));
            assertEquals(Source.VAULT, v.envSource("DATABASE_URL"));
            assertEquals(7, v.generation());
            assertEquals("prod", v.env());
        }
    }

    @Test
    void openWithWrongPassphraseSurfacesWrongPassphraseException() throws Exception {
        byte[] configBlob = mintConfigBlob();
        byte[] bundle = Rqe1.encryptForTest(
                "{\"k\":\"v\"}".getBytes(), PASSPHRASE, SALT, ITER);
        S3Fetcher fake = cfg -> new S3Fetcher.Fetched(manifest("20260101-120000"), bundle, 0);
        assertThrows(WrongPassphraseException.class,
                () -> VsyncClient.openWithBootstrap(configBlob, "WRONG",
                        new OpenOptions().withFetcher(fake)));
    }

    @Test
    void openWithFetcherErrorPropagatesS3Unreachable() throws Exception {
        byte[] configBlob = mintConfigBlob();
        S3Fetcher fake = cfg -> {
            throw new S3UnreachableException("simulated network down");
        };
        S3UnreachableException ex = assertThrows(S3UnreachableException.class,
                () -> VsyncClient.openWithBootstrap(configBlob, PASSPHRASE,
                        new OpenOptions().withFetcher(fake)));
        assertTrue(ex.getMessage().contains("simulated network down"));
    }

    @Test
    void openWithFetcherErrorPropagatesManifestNotFound() throws Exception {
        byte[] configBlob = mintConfigBlob();
        S3Fetcher fake = cfg -> {
            throw new ManifestNotFoundException("simulated 404");
        };
        assertThrows(ManifestNotFoundException.class,
                () -> VsyncClient.openWithBootstrap(configBlob, PASSPHRASE,
                        new OpenOptions().withFetcher(fake)));
    }

    @Test
    void openWithUnexpectedRuntimeExceptionWrapsAsS3Unreachable() throws Exception {
        byte[] configBlob = mintConfigBlob();
        S3Fetcher fake = cfg -> {
            throw new IllegalStateException("provider boom");
        };
        S3UnreachableException ex = assertThrows(S3UnreachableException.class,
                () -> VsyncClient.openWithBootstrap(configBlob, PASSPHRASE,
                        new OpenOptions().withFetcher(fake)));
        assertTrue(ex.getMessage().contains("provider boom"));
    }

    @Test
    void openWithMissingBootstrapThrowsConfigMissing() {
        assertThrows(ConfigMissingException.class,
                () -> VsyncClient.openWithBootstrap(new byte[0], "pp", new OpenOptions()));
    }

    // ─── openWith(config, passphrase) — v0.12 §4.4 ──────────────────────

    @Test
    void openWithAcceptsStringConfigAndPassphrase() throws Exception {
        // The public openWith() accepts the gzipped+base64url config blob as
        // a String (the same on-the-wire shape as VSYNC_CONFIG) plus a
        // passphrase. We need a fetcher seam to avoid touching real S3, so we
        // route through openWithBootstrap with byte-form inputs — same code
        // path the String form would call internally.
        byte[] configBlob = mintConfigBlob();
        String configStr = new String(configBlob, StandardCharsets.US_ASCII);
        byte[] bundle = Rqe1.encryptForTest(
                "{\"DATABASE_URL\":\"postgres://from-openwith\"}".getBytes(),
                PASSPHRASE, SALT, ITER);
        S3Fetcher fake = cfg -> new S3Fetcher.Fetched(manifest("20260101-120000"), bundle, 9);

        try (Vsync v = VsyncClient.openWith(configStr, PASSPHRASE,
                new OpenOptions().withFetcher(fake))) {
            assertEquals("postgres://from-openwith", v.getEnv("DATABASE_URL"));
            assertEquals(9, v.generation());
        }
    }

    @Test
    void openWithThrowsConfigMissingOnEmptyConfig() {
        assertThrows(ConfigMissingException.class,
                () -> VsyncClient.openWith("", PASSPHRASE));
        assertThrows(ConfigMissingException.class,
                () -> VsyncClient.openWith(null, PASSPHRASE));
    }

    @Test
    void openWithThrowsConfigMissingOnEmptyPassphrase() {
        assertThrows(ConfigMissingException.class,
                () -> VsyncClient.openWith("vsync-cfg-v1:xxx", ""));
        assertThrows(ConfigMissingException.class,
                () -> VsyncClient.openWith("vsync-cfg-v1:xxx", null));
    }

    @Test
    void openWithThreadsDefaultsToHandle() throws Exception {
        byte[] configBlob = mintConfigBlob();
        String configStr = new String(configBlob, StandardCharsets.US_ASCII);
        byte[] bundle = Rqe1.encryptForTest(
                "{}".getBytes(), PASSPHRASE, SALT, ITER);
        S3Fetcher fake = cfg -> new S3Fetcher.Fetched(manifest("20260101-120000"), bundle, 1);

        try (Vsync v = VsyncClient.openWith(configStr, PASSPHRASE,
                new OpenOptions()
                        .withFetcher(fake)
                        .withDefaults(Map.of("PORT", "8080")))) {
            assertEquals("8080", v.getEnv("PORT"));
            assertEquals(Source.DEFAULT, v.envSource("PORT"));
        }
    }

    @Test
    void openWithYieldsByteIdenticalDecryptionAsOpenForSameInputs() throws Exception {
        // Both paths converge on openWithBootstrap, so byte-equality is the
        // simplest invariant to pin: the bundle decrypted via openWith ==
        // the bundle decrypted via openWithBootstrap, for the same inputs.
        byte[] configBlob = mintConfigBlob();
        String configStr = new String(configBlob, StandardCharsets.US_ASCII);
        String secret = "{\"DATABASE_URL\":\"postgres://parity\",\"K\":\"VV\"}";
        byte[] bundle = Rqe1.encryptForTest(secret.getBytes(), PASSPHRASE, SALT, ITER);
        S3Fetcher fake = cfg -> new S3Fetcher.Fetched(manifest("20260101-120000"), bundle, 3);

        try (Vsync a = VsyncClient.openWith(configStr, PASSPHRASE,
                     new OpenOptions().withFetcher(fake));
             Vsync b = VsyncClient.openWithBootstrap(configBlob, PASSPHRASE,
                     new OpenOptions().withFetcher(fake))) {
            assertEquals(a.getEnv("DATABASE_URL"), b.getEnv("DATABASE_URL"));
            assertEquals(a.getEnv("K"), b.getEnv("K"));
            assertEquals(a.generation(), b.generation());
            assertEquals(a.env(), b.env());
            // Byte-identical asset path: same vault → same bytes for any key
            // present (none here, but the contract should still hold).
            assertArrayEquals(
                    a.getEnv("DATABASE_URL").getBytes(StandardCharsets.UTF_8),
                    b.getEnv("DATABASE_URL").getBytes(StandardCharsets.UTF_8));
        }
    }
}
