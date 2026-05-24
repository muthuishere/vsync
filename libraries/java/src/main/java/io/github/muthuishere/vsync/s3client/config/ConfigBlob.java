package io.github.muthuishere.vsync.s3client.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;
import io.github.muthuishere.vsync.s3client.exceptions.ConfigMissingException;
import io.github.muthuishere.vsync.s3client.exceptions.ConfigUnsupportedVersionException;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.GZIPInputStream;

/**
 * {@code VSYNC_CONFIG} bootstrap blob decoder.
 *
 * <p>Wire format (v0.12 §2.1):
 * <pre>vsync-cfg-v1:&lt;base64url-no-pad(gzip(JSON))&gt;</pre>
 *
 * <p>The magic prefix is also the schema-version handle:
 * <ul>
 *   <li>absent / non-{@code vsync-cfg-v1:} → {@link ConfigMissingException}</li>
 *   <li>present, base64url body decodes to non-gzip → {@link BundleCorruptException}</li>
 *   <li>present, gzip ok, JSON inner {@code v != 1} → {@link ConfigUnsupportedVersionException}</li>
 *   <li>standard-base64 characters in the body ({@code +}, {@code /}, {@code =}) →
 *       {@link ConfigUnsupportedVersionException} (operator hand-rolled with the wrong
 *       alphabet — refuse rather than silently translate)</li>
 * </ul>
 */
public final class ConfigBlob {

    private static final String BLOB_MAGIC = "vsync-cfg-v1:";
    private static final byte[] BLOB_MAGIC_BYTES = BLOB_MAGIC.getBytes(StandardCharsets.US_ASCII);
    private static final int SUPPORTED_INNER_V = 1;

    /**
     * Sanity floor on the salt's string length. The CLI emits 24-char base64url
     * ASCII; floor at 16 so a typo'd / truncated blob fails fast. The bytes fed
     * to PBKDF2 are these chars' UTF-8 encoding verbatim — NOT base64-decoded.
     */
    private static final int MIN_SALT_CHARS = 16;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ConfigBlob() {
    }

    public static VsyncConfig decode(byte[] blob) {
        if (blob == null || blob.length < BLOB_MAGIC_BYTES.length
                || !startsWith(blob, BLOB_MAGIC_BYTES)) {
            throw new ConfigMissingException(
                    "VSYNC_CONFIG: missing 'vsync-cfg-v1:' prefix — "
                            + "did you paste raw JSON, or are you holding a newer (v2+) blob?");
        }
        byte[] body = new byte[blob.length - BLOB_MAGIC_BYTES.length];
        System.arraycopy(blob, BLOB_MAGIC_BYTES.length, body, 0, body.length);

        // Strict base64url rejection. Any '+', '/', '=' is the standard alphabet —
        // refuse loudly rather than silently re-encode (which would mask the
        // operator's mistake).
        for (byte b : body) {
            if (b == '+' || b == '/' || b == '=') {
                throw new ConfigUnsupportedVersionException(
                        "VSYNC_CONFIG: body must be base64url-no-pad per v0.12 §2.1; "
                                + "found disallowed character " + (char) b
                                + " (use '-' and '_' instead of '+' and '/'; drop padding '=')");
            }
        }

        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(body);
        } catch (IllegalArgumentException e) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: base64url body failed to decode: " + e.getMessage(), e);
        }

        // Gzip magic sniff: catches the "valid base64 of junk bytes" case before
        // we burn cycles in GZIPInputStream's reader.
        if (decoded.length < 2 || decoded[0] != (byte) 0x1f || decoded[1] != (byte) 0x8b) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: body is not a gzip stream (wrong magic bytes)");
        }

        byte[] rawJson;
        try (GZIPInputStream gz = new GZIPInputStream(new ByteArrayInputStream(decoded))) {
            rawJson = gz.readAllBytes();
        } catch (IOException e) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: gzip decompress failed: " + e.getMessage(), e);
        }

        JsonNode obj;
        try {
            obj = MAPPER.readTree(rawJson);
        } catch (JsonProcessingException e) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: inner JSON failed to parse: " + e.getMessage(), e);
        } catch (IOException e) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: inner JSON read failed: " + e.getMessage(), e);
        }
        if (!obj.isObject()) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: inner JSON must be an object, got " + obj.getNodeType());
        }

        // Probe `v` first so the corpus's negative-unknown-version vector
        // surfaces the right error before any field-level checks.
        JsonNode vNode = obj.get("v");
        if (vNode == null || !vNode.isInt() || vNode.intValue() != SUPPORTED_INNER_V) {
            throw new ConfigUnsupportedVersionException(
                    "VSYNC_CONFIG: inner v=" + (vNode == null ? "missing" : vNode.asText())
                            + "; this library understands v=1 only — upgrade vsync-s3-client");
        }

        try {
            int iterations = requireInt(obj, "iterations");
            if (iterations <= 0) {
                throw new BundleCorruptException(
                        "VSYNC_CONFIG: iterations must be > 0, got " + iterations);
            }
            String salt = requireString(obj, "salt");
            if (salt.length() < MIN_SALT_CHARS) {
                throw new ConfigUnsupportedVersionException(
                        "VSYNC_CONFIG: salt string is " + salt.length()
                                + " chars (< " + MIN_SALT_CHARS + " minimum)");
            }
            return new VsyncConfig(
                    SUPPORTED_INNER_V,
                    requireString(obj, "endpoint"),
                    requireString(obj, "region"),
                    requireString(obj, "bucket"),
                    requireString(obj, "accessKeyId"),
                    requireString(obj, "secretAccessKey"),
                    requireString(obj, "prefix"),
                    requireString(obj, "env"),
                    salt,
                    iterations);
        } catch (MissingFieldException e) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: inner JSON is missing required field '" + e.field + "'", e);
        }
    }

    private static boolean startsWith(byte[] data, byte[] prefix) {
        if (data.length < prefix.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i++) {
            if (data[i] != prefix[i]) {
                return false;
            }
        }
        return true;
    }

    private static String requireString(JsonNode obj, String field) {
        JsonNode n = obj.get(field);
        if (n == null || n.isNull()) {
            throw new MissingFieldException(field);
        }
        return n.asText();
    }

    private static int requireInt(JsonNode obj, String field) {
        JsonNode n = obj.get(field);
        if (n == null || n.isNull()) {
            throw new MissingFieldException(field);
        }
        if (!n.canConvertToInt()) {
            throw new BundleCorruptException(
                    "VSYNC_CONFIG: " + field + " must be an int, got " + n.getNodeType());
        }
        return n.intValue();
    }

    private static final class MissingFieldException extends RuntimeException {
        final String field;

        MissingFieldException(String field) {
            super("missing field: " + field);
            this.field = field;
        }
    }
}
