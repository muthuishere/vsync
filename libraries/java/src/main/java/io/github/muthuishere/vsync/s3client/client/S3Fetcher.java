package io.github.muthuishere.vsync.s3client.client;

import io.github.muthuishere.vsync.s3client.config.VsyncConfig;

/**
 * Abstracts the S3 round trip so {@link VsyncClient#open(OpenOptions)} stays
 * testable without spinning up real AWS. The default fetcher (see
 * {@link io.github.muthuishere.vsync.s3client.client.DefaultS3Fetcher}) uses
 * AWS SDK Java v2; tests inject a fake via {@link OpenOptions#withFetcher}.
 *
 * <p>Returning a manifest + bundle + generation lets the caller (Open) own
 * the structural checks (RQEM0001 unwrap, RQE1 decrypt, vault parse) without
 * each Fetcher implementation having to re-implement them.
 *
 * <p>{@link #fetchGeneration} is the lightweight read path used by
 * {@link Vsync#remoteGeneration} / {@link Vsync#hasNewVersion} (v0.12 §7.1).
 * The default impl just delegates to {@link #fetch}; production fetchers
 * (and tests that want to exercise the polling path independently) override
 * it to skip the bundle round-trip.
 */
@FunctionalInterface
public interface S3Fetcher {

    Fetched fetch(VsyncConfig cfg);

    /**
     * Re-read just the generation counter from the remote manifest. Used by
     * the explicit-poll carve-out ({@link Vsync#remoteGeneration}). The
     * caller's local {@code generation} field is NOT mutated by this call —
     * see v0.12 §4.5.
     *
     * <p>Default impl delegates to {@link #fetch} and discards the bundle.
     * That's correct but pays for the bundle bytes — override to skip the
     * bundle GET when polling is on a hot path.
     *
     * <p>Throws the same exception classes as {@link #fetch}
     * ({@code S3UnreachableException}, {@code ManifestNotFoundException}).
     */
    default long fetchGeneration(VsyncConfig cfg) {
        return fetch(cfg).generation();
    }

    record Fetched(byte[] manifest, byte[] bundle, long generation) {
    }
}
