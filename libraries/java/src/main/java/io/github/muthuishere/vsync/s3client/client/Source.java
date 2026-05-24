package io.github.muthuishere.vsync.s3client.client;

/**
 * Names the step in the v0.12 §5 fallback chain that resolved a lookup.
 * Safe to log — never carries the value itself. The wire form (used in
 * conformance vectors) is the lowercase enum name.
 */
public enum Source {
    VAULT("vault"),
    ENV("env"),
    DEFAULT("default"),
    MISSING("missing");

    private final String wire;

    Source(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    @Override
    public String toString() {
        return wire;
    }
}
