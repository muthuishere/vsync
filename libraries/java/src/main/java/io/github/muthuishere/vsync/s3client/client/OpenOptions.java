package io.github.muthuishere.vsync.s3client.client;

import java.util.HashMap;
import java.util.Map;

/**
 * Options for {@link VsyncClient#open(OpenOptions)}. Immutable; build with
 * the chained {@code with*} methods, e.g.
 * {@code new OpenOptions().withDefaults(Map.of("PORT", "8080"))}.
 */
public final class OpenOptions {

    private S3Fetcher fetcher;
    private Map<String, String> defaults = Map.of();

    public OpenOptions withFetcher(S3Fetcher fetcher) {
        this.fetcher = fetcher;
        return this;
    }

    public OpenOptions withDefaults(Map<String, String> defaults) {
        this.defaults = defaults == null ? Map.of() : new HashMap<>(defaults);
        return this;
    }

    public S3Fetcher fetcher() {
        return fetcher;
    }

    public Map<String, String> defaults() {
        return defaults;
    }
}
