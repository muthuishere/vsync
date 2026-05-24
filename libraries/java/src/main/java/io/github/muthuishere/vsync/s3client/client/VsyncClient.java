package io.github.muthuishere.vsync.s3client.client;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.muthuishere.vsync.s3client.config.ConfigBlob;
import io.github.muthuishere.vsync.s3client.config.VsyncConfig;
import io.github.muthuishere.vsync.s3client.crypto.Rqe1;
import io.github.muthuishere.vsync.s3client.crypto.Rqem0001;
import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;
import io.github.muthuishere.vsync.s3client.exceptions.ConfigMissingException;
import io.github.muthuishere.vsync.s3client.exceptions.S3UnreachableException;
import io.github.muthuishere.vsync.s3client.exceptions.VSyncException;
import io.github.muthuishere.vsync.s3client.sources.BootstrapSources;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Static factory for {@link Vsync}. The public surface is
 * {@link #open()} and {@link #open(OpenOptions)}.
 *
 * <p>{@code open()} reads {@code VSYNC_CONFIG} + {@code VSYNC_PASSPHRASE}
 * from the process env (or their {@code _FILE} variants), runs one S3
 * round trip via the configured {@link S3Fetcher}, decrypts the bundle,
 * and returns an in-memory {@link Vsync} handle.
 *
 * <p>Fail-loud: if S3 is down, IAM is wrong, or the bundle is corrupt,
 * {@code open()} raises — it does NOT silently degrade to env-vars-only
 * (v0.12 §8).
 */
public final class VsyncClient {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private VsyncClient() {
    }

    public static Vsync open() {
        return open(new OpenOptions());
    }

    public static Vsync open(OpenOptions opts) {
        BootstrapSources.Resolved bootstrap = BootstrapSources.resolve();
        return openWithBootstrap(bootstrap.configBlob(), bootstrap.passphrase(),
                opts == null ? new OpenOptions() : opts);
    }

    /**
     * Open with the bootstrap inputs supplied as strings (v0.12 §4.4). The
     * counterpart to {@link #open()} for callers whose config lives in a
     * custom secrets store (KMS, Hashicorp Vault, a CI variable) instead of
     * a process env var. Behavioral parity with {@code open()} from then on.
     *
     * @param config the {@code vsync-cfg-v1:<base64url-gzip-json>} blob
     * @param passphrase the RQE1 passphrase
     * @throws ConfigMissingException if either argument is null or empty
     */
    public static Vsync openWith(String config, String passphrase) {
        return openWith(config, passphrase, new OpenOptions());
    }

    public static Vsync openWith(String config, String passphrase, OpenOptions opts) {
        if (config == null || config.isEmpty()) {
            throw new ConfigMissingException(
                    "vsync: openWith(config, ...) — config must be non-empty (v0.12 §2)");
        }
        if (passphrase == null || passphrase.isEmpty()) {
            throw new ConfigMissingException(
                    "vsync: openWith(..., passphrase) — passphrase must be non-empty (v0.12 §2)");
        }
        return openWithBootstrap(
                config.getBytes(StandardCharsets.UTF_8),
                passphrase,
                opts == null ? new OpenOptions() : opts);
    }

    /**
     * Lower-level entry point that takes pre-resolved bootstrap inputs.
     * Tests use this to avoid the {@code System.getenv} round trip — the
     * JVM doesn't expose a portable env-set hook, so injecting the bootstrap
     * directly is the cleanest seam.
     */
    public static Vsync openWithBootstrap(byte[] configBlob, String passphrase, OpenOptions opts) {
        VsyncConfig cfg = ConfigBlob.decode(configBlob);
        OpenOptions effective = opts == null ? new OpenOptions() : opts;
        S3Fetcher fetcher = effective.fetcher();
        if (fetcher == null) {
            fetcher = DefaultS3Fetcher.INSTANCE;
        }
        S3Fetcher.Fetched fetched;
        try {
            fetched = fetcher.fetch(cfg);
        } catch (VSyncException e) {
            // Caller-provided sentinels propagate untouched (matches Go's
            // isVSyncSentinel) — preserves error class identity for the
            // conformance corpus.
            throw e;
        } catch (RuntimeException e) {
            throw new S3UnreachableException(
                    "vsync: S3 fetch failed: " + e.getMessage(), e);
        }
        // Belt-and-braces unwrap (default fetcher already does this).
        Rqem0001.unwrap(fetched.manifest());
        byte[] plaintext = Rqe1.decrypt(
                fetched.bundle(), passphrase, cfg.salt(), cfg.iterations());
        ParsedVault parsed = parseVaultPayload(plaintext);
        return new Vsync(
                parsed.kv,
                parsed.assets,
                new HashMap<>(effective.defaults()),
                fetched.generation(),
                cfg.env(),
                fetcher,
                cfg);
    }

    private record ParsedVault(Map<String, String> kv, Map<String, byte[]> assets) {
    }

    /**
     * Decode the decrypted bundle plaintext into (kv, assets). Two shapes
     * are accepted — mirrors Python / Go behaviour:
     * <ul>
     *   <li>flat object: every value is a string KV (used by the
     *       fallback-chain conformance vectors)</li>
     *   <li>nested {@code { "kv": {...}, "assets": {<name>: <base64>} }}</li>
     * </ul>
     */
    private static ParsedVault parseVaultPayload(byte[] payload) {
        JsonNode root;
        try {
            root = MAPPER.readTree(payload);
        } catch (JsonProcessingException e) {
            throw new BundleCorruptException(
                    "vault payload is not valid JSON: " + e.getMessage(), e);
        } catch (IOException e) {
            throw new BundleCorruptException(
                    "vault payload read failed: " + e.getMessage(), e);
        }
        if (root == null || !root.isObject()) {
            throw new BundleCorruptException(
                    "vault payload root must be a JSON object");
        }
        Map<String, String> kv = new HashMap<>();
        Map<String, byte[]> assets = new HashMap<>();
        boolean hasNested = root.has("kv") || root.has("assets");
        if (hasNested) {
            JsonNode kvNode = root.get("kv");
            if (kvNode != null && !kvNode.isNull()) {
                if (!kvNode.isObject()) {
                    throw new BundleCorruptException(
                            "vault payload: `kv` must be a JSON object");
                }
                for (Iterator<Map.Entry<String, JsonNode>> it = kvNode.fields(); it.hasNext(); ) {
                    Map.Entry<String, JsonNode> e = it.next();
                    if (!e.getValue().isTextual()) {
                        throw new BundleCorruptException(
                                "vault.kv[" + e.getKey() + "] must be a string");
                    }
                    kv.put(e.getKey(), e.getValue().asText());
                }
            }
            JsonNode aNode = root.get("assets");
            if (aNode != null && !aNode.isNull()) {
                if (!aNode.isObject()) {
                    throw new BundleCorruptException(
                            "vault payload: `assets` must be a JSON object");
                }
                for (Iterator<Map.Entry<String, JsonNode>> it = aNode.fields(); it.hasNext(); ) {
                    Map.Entry<String, JsonNode> e = it.next();
                    if (!e.getValue().isTextual()) {
                        throw new BundleCorruptException(
                                "vault.assets[" + e.getKey() + "] must be a base64 string");
                    }
                    try {
                        assets.put(e.getKey(),
                                Base64.getDecoder().decode(e.getValue().asText()));
                    } catch (IllegalArgumentException ex) {
                        throw new BundleCorruptException(
                                "vault.assets[" + e.getKey() + "] is not valid base64: "
                                        + ex.getMessage(), ex);
                    }
                }
            }
            return new ParsedVault(kv, assets);
        }
        // Flat shape: every value must be a string.
        for (Iterator<Map.Entry<String, JsonNode>> it = root.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            if (!e.getValue().isTextual()) {
                throw new BundleCorruptException(
                        "vault[" + e.getKey() + "] must be a string in flat shape");
            }
            kv.put(e.getKey(), e.getValue().asText());
        }
        return new ParsedVault(kv, assets);
    }

    // Tiny helper so the default fetcher and the unit tests can both
    // construct a UTF-8 byte view without sprinkling StandardCharsets calls.
    static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
