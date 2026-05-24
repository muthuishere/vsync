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
 */
@FunctionalInterface
public interface S3Fetcher {

    Fetched fetch(VsyncConfig cfg);

    record Fetched(byte[] manifest, byte[] bundle, int generation) {
    }
}
