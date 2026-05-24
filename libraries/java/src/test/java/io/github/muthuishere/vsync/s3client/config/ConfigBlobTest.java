package io.github.muthuishere.vsync.s3client.config;

import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;
import io.github.muthuishere.vsync.s3client.exceptions.ConfigMissingException;
import io.github.muthuishere.vsync.s3client.exceptions.ConfigUnsupportedVersionException;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.GZIPOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ConfigBlobTest {

    private static byte[] mintBlob(String json) throws Exception {
        ByteArrayOutputStream gz = new ByteArrayOutputStream();
        try (GZIPOutputStream g = new GZIPOutputStream(gz)) {
            g.write(json.getBytes(StandardCharsets.UTF_8));
        }
        String b64url = Base64.getUrlEncoder().withoutPadding().encodeToString(gz.toByteArray());
        return ("vsync-cfg-v1:" + b64url).getBytes(StandardCharsets.US_ASCII);
    }

    @Test
    void decodesValidBlob() throws Exception {
        String json = "{"
                + "\"v\":1,"
                + "\"endpoint\":\"https://s3.amazonaws.com\","
                + "\"region\":\"us-east-1\","
                + "\"bucket\":\"acme-secrets\","
                + "\"accessKeyId\":\"AKIA000000000000\","
                + "\"secretAccessKey\":\"secretkey\","
                + "\"prefix\":\"myapp/\","
                + "\"env\":\"prod\","
                + "\"salt\":\"abcdefghijklmnop\","
                + "\"iterations\":600000"
                + "}";
        VsyncConfig cfg = ConfigBlob.decode(mintBlob(json));
        assertEquals(1, cfg.v());
        assertEquals("https://s3.amazonaws.com", cfg.endpoint());
        assertEquals("acme-secrets", cfg.bucket());
        assertEquals("prod", cfg.env());
        assertEquals("abcdefghijklmnop", cfg.salt());
        assertEquals(600000, cfg.iterations());
    }

    @Test
    void missingMagicThrowsConfigMissing() {
        byte[] blob = "{\"v\":1}".getBytes();
        assertThrows(ConfigMissingException.class, () -> ConfigBlob.decode(blob));
    }

    @Test
    void nullThrowsConfigMissing() {
        assertThrows(ConfigMissingException.class, () -> ConfigBlob.decode(null));
    }

    @Test
    void standardBase64CharThrowsConfigUnsupportedVersion() {
        // Magic ok, but the body contains '+' / '/' / '=' — RFC 4648 §5 says no.
        byte[] blob = ("vsync-cfg-v1:abc+def").getBytes(StandardCharsets.US_ASCII);
        assertThrows(ConfigUnsupportedVersionException.class,
                () -> ConfigBlob.decode(blob));
    }

    @Test
    void paddingCharThrowsConfigUnsupportedVersion() {
        byte[] blob = ("vsync-cfg-v1:abcdef==").getBytes(StandardCharsets.US_ASCII);
        assertThrows(ConfigUnsupportedVersionException.class,
                () -> ConfigBlob.decode(blob));
    }

    @Test
    void nonGzipBodyThrowsBundleCorrupt() {
        // Magic + base64url of "not-gzip-bytes" — decodes cleanly but no gzip magic.
        String b64 = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("not-gzip-bytes".getBytes());
        byte[] blob = ("vsync-cfg-v1:" + b64).getBytes(StandardCharsets.US_ASCII);
        assertThrows(BundleCorruptException.class, () -> ConfigBlob.decode(blob));
    }

    @Test
    void unknownInnerVersionThrowsConfigUnsupportedVersion() throws Exception {
        byte[] blob = mintBlob("{\"v\":99,\"endpoint\":\"x\"}");
        assertThrows(ConfigUnsupportedVersionException.class,
                () -> ConfigBlob.decode(blob));
    }

    @Test
    void missingRequiredFieldThrowsBundleCorrupt() throws Exception {
        // v=1 but no endpoint.
        byte[] blob = mintBlob("{\"v\":1,\"salt\":\"abcdefghijklmnop\",\"iterations\":1}");
        assertThrows(BundleCorruptException.class, () -> ConfigBlob.decode(blob));
    }

    @Test
    void saltShorterThanFloorThrowsConfigUnsupportedVersion() throws Exception {
        byte[] blob = mintBlob("{\"v\":1,"
                + "\"endpoint\":\"e\",\"region\":\"r\",\"bucket\":\"b\","
                + "\"accessKeyId\":\"k\",\"secretAccessKey\":\"s\",\"prefix\":\"p/\","
                + "\"env\":\"prod\",\"salt\":\"shortie\",\"iterations\":1}");
        assertThrows(ConfigUnsupportedVersionException.class,
                () -> ConfigBlob.decode(blob));
    }

    @Test
    void zeroIterationsThrowsBundleCorrupt() throws Exception {
        byte[] blob = mintBlob("{\"v\":1,"
                + "\"endpoint\":\"e\",\"region\":\"r\",\"bucket\":\"b\","
                + "\"accessKeyId\":\"k\",\"secretAccessKey\":\"s\",\"prefix\":\"p/\","
                + "\"env\":\"prod\",\"salt\":\"abcdefghijklmnop\",\"iterations\":0}");
        assertThrows(BundleCorruptException.class, () -> ConfigBlob.decode(blob));
    }

    @Test
    void toStringIsRedacted() {
        VsyncConfig cfg = new VsyncConfig(
                1, "https://s3.example", "r", "b",
                "AKIAEXAMPLE", "SUPER-SECRET", "p/", "prod",
                "saltsaltsaltsalt", 1000);
        String s = cfg.toString();
        assertTrue(s.contains("<redacted>"));
        assertTrue(s.contains("env=prod"));
        assertTrue(!s.contains("SUPER-SECRET"));
        assertTrue(!s.contains("saltsaltsaltsalt"));
    }
}
