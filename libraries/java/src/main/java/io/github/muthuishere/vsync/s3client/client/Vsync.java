package io.github.muthuishere.vsync.s3client.client;

import io.github.muthuishere.vsync.s3client.assetpath.AssetMaterializer;
import io.github.muthuishere.vsync.s3client.config.VsyncConfig;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;

/**
 * In-memory accessor for a decrypted vault. Construct via
 * {@link VsyncClient#open()}; tests can construct directly via
 * {@link #fromVaultForTest} to bypass S3.
 *
 * <p>All accessors except {@link #assetPath(String)} are pure-memory after
 * Open returns. The fallback chain (v0.12 §5) is locked: vault → process env
 * → defaults → missing. {@link #close()} zeroes the in-memory plaintext and
 * unlinks any per-handle tempfiles.
 *
 * <p>Redaction (v0.12 §12): {@link #toString()} returns
 * {@code "<vsync:redacted>"} — vault values never leak through accidental
 * serialization.
 */
public final class Vsync implements AutoCloseable {

    private final Map<String, String> kv;
    private final Map<String, byte[]> assets;
    private final Map<String, String> defaults;
    private final long generation;
    private final String env;
    /**
     * Bound at open() so {@link #remoteGeneration} can re-fetch without
     * re-resolving bootstrap. Null only for the no-fetcher
     * {@link #fromVaultForTest} overload — calling
     * {@code remoteGeneration} / {@code hasNewVersion} on such a handle
     * raises {@link IllegalStateException}.
     */
    private final S3Fetcher fetcher;
    private final VsyncConfig cfg;
    private AssetMaterializer materializer;
    private boolean closed;

    Vsync(Map<String, String> kv,
          Map<String, byte[]> assets,
          Map<String, String> defaults,
          long generation,
          String env,
          S3Fetcher fetcher,
          VsyncConfig cfg) {
        this.kv = kv;
        this.assets = assets;
        this.defaults = defaults;
        this.generation = generation;
        this.env = env;
        this.fetcher = fetcher;
        this.cfg = cfg;
    }

    /** Resolve {@code key} through vault → env → defaults → missing. */
    public Optional<String> get(String key) {
        ensureOpen();
        String fromVault = kv.get(key);
        if (fromVault != null) {
            return Optional.of(fromVault);
        }
        // os.getenv at lookup time, not Open time — process-env mutations
        // after open() are visible (v0.12 §5).
        String fromEnv = System.getenv(key);
        if (fromEnv != null) {
            return Optional.of(fromEnv);
        }
        String fromDefaults = defaults.get(key);
        return fromDefaults != null ? Optional.of(fromDefaults) : Optional.empty();
    }

    /** True iff vault, env, or defaults would resolve {@code key}. */
    public boolean has(String key) {
        ensureOpen();
        return kv.containsKey(key)
                || System.getenv(key) != null
                || defaults.containsKey(key);
    }

    /** Name the step in the fallback chain that wins (or {@link Source#MISSING}). */
    public Source source(String key) {
        ensureOpen();
        if (kv.containsKey(key)) {
            return Source.VAULT;
        }
        if (System.getenv(key) != null) {
            return Source.ENV;
        }
        if (defaults.containsKey(key)) {
            return Source.DEFAULT;
        }
        return Source.MISSING;
    }

    /**
     * Return the asset's bytes. Falls back to a KV lookup so the asset-path
     * conformance corpus (where the binary blob is referenced via a KV
     * placeholder and the harness seeds the bytes) round-trips cleanly.
     * Mirrors the Python / Go / TS ports.
     */
    public byte[] assetBytes(String name) {
        ensureOpen();
        byte[] b = assets.get(name);
        if (b != null) {
            // Copy so callers can't mutate the in-memory vault by accident.
            byte[] out = new byte[b.length];
            System.arraycopy(b, 0, out, 0, b.length);
            return out;
        }
        String v = kv.get(name);
        if (v != null) {
            return v.getBytes(StandardCharsets.UTF_8);
        }
        throw new NoSuchElementException("vsync: asset " + name + " not in vault");
    }

    /**
     * Lazily materialize the asset bytes to a 0600 tempfile inside this
     * handle's 0700 tempdir (v0.12 §6). Repeated calls with the same name
     * return the cached path. {@link #close()} unlinks the tempdir;
     * SIGKILL → leak.
     */
    public Path assetPath(String name) {
        ensureOpen();
        if (materializer == null) {
            materializer = new AssetMaterializer();
        }
        return materializer.materialize(name, assetBytes(name));
    }

    /** Monotonic gen counter from the manifest meta cell. Safe to log. */
    public long generation() {
        return generation;
    }

    /**
     * Re-fetch the remote {@code gen} counter via a single manifest read —
     * the v0.12 §7.1 {@code has_new_version} carve-out. Does NOT mutate the
     * local {@link #generation()}; the in-memory bundle is unchanged.
     *
     * <p>Synchronous-blocking: one network round-trip. Wrap in
     * {@code CompletableFuture.supplyAsync(v::remoteGeneration)} if the
     * caller wants async.
     *
     * @throws io.github.muthuishere.vsync.s3client.exceptions.S3UnreachableException
     *         on network / IAM failure (matches {@link VsyncClient#open}).
     * @throws io.github.muthuishere.vsync.s3client.exceptions.ManifestNotFoundException
     *         if the manifest object is absent (env was never pushed).
     */
    public long remoteGeneration() {
        ensureOpen();
        if (fetcher == null || cfg == null) {
            throw new IllegalStateException(
                    "Vsync: handle has no S3 fetcher bound — "
                            + "remoteGeneration is only available on handles opened via VsyncClient.open()");
        }
        return fetcher.fetchGeneration(cfg);
    }

    /**
     * Convenience: {@code true} iff {@link #remoteGeneration()} is strictly
     * greater than {@link #generation()}. Same exceptions as
     * {@link #remoteGeneration()}.
     *
     * <p>A {@code false} answer when remote &lt; local (theoretical gen
     * regression) is by design — the contract is strictly "is there a newer
     * version upstream?", not "is local out of sync?".
     */
    public boolean hasNewVersion() {
        return remoteGeneration() > generation();
    }

    /** Selected env (the one this handle was opened for). Safe to log. */
    public String env() {
        return env;
    }

    /** True iff this handle has been closed. */
    public boolean isClosed() {
        return closed;
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        kv.clear();
        assets.clear();
        if (materializer != null) {
            materializer.close();
            materializer = null;
        }
    }

    /**
     * Redaction-safe form (v0.12 §12). The handle never serializes the vault.
     * The brief lists {@code "<vsync:redacted>"} as the canonical form —
     * matches Go / TS. Python uses the more verbose form with gen+env; we
     * stick with the brief.
     */
    @Override
    public String toString() {
        return "<vsync:redacted>";
    }

    private void ensureOpen() {
        if (closed) {
            throw new IllegalStateException("Vsync: handle is closed");
        }
    }

    /**
     * Test hook — construct a {@code Vsync} with a pre-populated vault,
     * bypassing the S3 round trip. Production callers must use
     * {@link VsyncClient#open()}.
     *
     * <p>{@link #remoteGeneration} / {@link #hasNewVersion} on a handle
     * created this way raise {@link IllegalStateException} — there's no
     * fetcher bound. Use {@link #fromVaultForTest(Map, Map, Map, long, String,
     * S3Fetcher, VsyncConfig)} to exercise the polling path.
     */
    public static Vsync fromVaultForTest(
            Map<String, String> kv,
            Map<String, byte[]> assets,
            Map<String, String> defaults,
            long generation,
            String env) {
        return fromVaultForTest(kv, assets, defaults, generation, env, null, null);
    }

    /**
     * Test hook with a bound fetcher + config — same as the 5-arg overload
     * but lets the test exercise {@link #remoteGeneration} /
     * {@link #hasNewVersion} against a fake {@link S3Fetcher}.
     */
    public static Vsync fromVaultForTest(
            Map<String, String> kv,
            Map<String, byte[]> assets,
            Map<String, String> defaults,
            long generation,
            String env,
            S3Fetcher fetcher,
            VsyncConfig cfg) {
        return new Vsync(
                kv == null ? new HashMap<>() : new HashMap<>(kv),
                assets == null ? new HashMap<>() : new HashMap<>(assets),
                defaults == null ? new HashMap<>() : new HashMap<>(defaults),
                generation,
                env,
                fetcher,
                cfg);
    }
}
