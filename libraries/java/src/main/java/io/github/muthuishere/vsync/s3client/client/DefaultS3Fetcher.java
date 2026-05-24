package io.github.muthuishere.vsync.s3client.client;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.muthuishere.vsync.s3client.config.VsyncConfig;
import io.github.muthuishere.vsync.s3client.crypto.Rqem0001;
import io.github.muthuishere.vsync.s3client.exceptions.BundleCorruptException;
import io.github.muthuishere.vsync.s3client.exceptions.ManifestNotFoundException;
import io.github.muthuishere.vsync.s3client.exceptions.S3UnreachableException;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.net.URI;

/**
 * Default {@link S3Fetcher} implementation, backed by AWS SDK Java v2.
 *
 * <p>One round trip per Open: GET {@code <prefix>manifest} → unwrap RQEM0001 →
 * GET {@code <prefix>v=<ts>} bundle. The optional {@code <prefix>latest.meta}
 * cell carries the {@code gen=N} counter; missing / unreadable → gen=0.
 *
 * <p>Error mapping (v0.12 §11):
 * <ul>
 *   <li>404 on the manifest → {@link ManifestNotFoundException} (bucket
 *       reachable, env not yet pushed)</li>
 *   <li>404 on the bundle the manifest pointed at → {@link BundleCorruptException}
 *       (bucket is in a torn state — re-push)</li>
 *   <li>any other network / IAM / SDK failure → {@link S3UnreachableException}</li>
 * </ul>
 */
final class DefaultS3Fetcher implements S3Fetcher {

    static final DefaultS3Fetcher INSTANCE = new DefaultS3Fetcher();

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private DefaultS3Fetcher() {
    }

    @Override
    public Fetched fetch(VsyncConfig cfg) {
        S3Client client = buildClient(cfg);
        try {
            String manifestKey = cfg.prefix() + "manifest";
            byte[] manifestBytes = getObject(client, cfg.bucket(), manifestKey, /*isManifest*/ true);
            Rqem0001.Result m = Rqem0001.unwrap(manifestBytes);
            String bundleKey = cfg.prefix() + "v=" + m.timestamp();
            byte[] bundleBytes = getObject(client, cfg.bucket(), bundleKey, /*isManifest*/ false);
            int gen = fetchOptionalGeneration(client, cfg);
            return new Fetched(manifestBytes, bundleBytes, gen);
        } finally {
            client.close();
        }
    }

    private byte[] getObject(S3Client client, String bucket, String key, boolean isManifest) {
        try {
            return client.getObjectAsBytes(GetObjectRequest.builder()
                    .bucket(bucket)
                    .key(key)
                    .build()).asByteArray();
        } catch (NoSuchKeyException e) {
            if (isManifest) {
                throw new ManifestNotFoundException(
                        "vsync: s3://" + bucket + "/" + key + " is 404 — "
                                + "run `vsync push` once before booting apps", e);
            }
            throw new BundleCorruptException(
                    "vsync: manifest points at s3://" + bucket + "/" + key
                            + " but the object is 404 — the bucket is in a torn state; re-push", e);
        } catch (S3Exception e) {
            int status = e.statusCode();
            if (status == 404 && isManifest) {
                throw new ManifestNotFoundException(
                        "vsync: s3://" + bucket + "/" + key + " is 404", e);
            }
            throw new S3UnreachableException(
                    "vsync: cannot read s3://" + bucket + "/" + key + ": " + e.getMessage(), e);
        } catch (SdkException e) {
            throw new S3UnreachableException(
                    "vsync: network / endpoint error reaching " + bucket + ": " + e.getMessage(), e);
        }
    }

    private int fetchOptionalGeneration(S3Client client, VsyncConfig cfg) {
        try {
            byte[] meta = client.getObjectAsBytes(GetObjectRequest.builder()
                    .bucket(cfg.bucket())
                    .key(cfg.prefix() + "latest.meta")
                    .build()).asByteArray();
            JsonNode node = MAPPER.readTree(meta);
            if (node != null && node.has("gen") && node.get("gen").isInt()) {
                return node.get("gen").intValue();
            }
        } catch (Exception ignored) {
            // Pre-rotation bundle has no meta cell — gen stays 0.
        }
        return 0;
    }

    private static S3Client buildClient(VsyncConfig cfg) {
        return S3Client.builder()
                .endpointOverride(URI.create(cfg.endpoint()))
                .region(Region.of(cfg.region()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(cfg.accessKeyId(), cfg.secretAccessKey())))
                .build();
    }
}
