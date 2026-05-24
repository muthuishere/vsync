package io.github.muthuishere.vsync.s3client.conformance;

import com.fasterxml.jackson.databind.JsonNode;

import java.nio.file.Path;

/**
 * One conformance fixture: metadata JSON + (optional) sibling bytes.
 * Mirrors Python's {@code tests/conformance/loader.Vector} and Go's
 * {@code conformance_test.vector}.
 */
public record Vector(
        String category,
        String name,
        Path jsonPath,
        Path binPath,
        byte[] binBytes,
        JsonNode meta) {

    public String description() {
        JsonNode d = meta.get("description");
        return d == null ? "(no description)" : d.asText();
    }

    public String expectedError() {
        JsonNode exp = meta.get("expected");
        if (exp == null) {
            return null;
        }
        JsonNode err = exp.get("error");
        if (err == null || err.isNull()) {
            return null;
        }
        return err.asText();
    }

    public JsonNode inputs() {
        return meta.has("inputs") ? meta.get("inputs") : null;
    }

    public JsonNode expected() {
        return meta.has("expected") ? meta.get("expected") : null;
    }

    @Override
    public String toString() {
        return category + "/" + name;
    }
}
