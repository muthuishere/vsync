package io.github.muthuishere.vsync.s3client.config;

/**
 * Decoded inner JSON of the {@code VSYNC_CONFIG} blob.
 *
 * <p>Field names mirror v0.12 §2.1 (camelCase JSON wire keys). The
 * {@link #salt} field is the PBKDF2 salt as it appears in the blob —
 * readers MUST feed the UTF-8 bytes of this string verbatim to PBKDF2
 * (Convention A, locked at bc52f51); do NOT base64-decode first, even
 * though the CLI happens to mint a base64url-shaped string.
 *
 * <p>The {@code toString()} is redaction-safe: it shows endpoint / region /
 * bucket / env / prefix / iterations but hides the IAM credentials and
 * salt.
 */
public record VsyncConfig(
        int v,
        String endpoint,
        String region,
        String bucket,
        String accessKeyId,
        String secretAccessKey,
        String prefix,
        String env,
        String salt,
        int iterations) {

    @Override
    public String toString() {
        return "VsyncConfig{"
                + "v=" + v
                + ", endpoint=" + endpoint
                + ", region=" + region
                + ", bucket=" + bucket
                + ", env=" + env
                + ", prefix=" + prefix
                + ", iterations=" + iterations
                + ", accessKeyId=<redacted>, secretAccessKey=<redacted>, salt=<redacted>"
                + '}';
    }
}
