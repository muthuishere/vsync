package io.github.muthuishere.vsync.s3client.conformance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * Conformance corpus walker.
 *
 * <p>Per v0.11 §7. Walks {@code docs/specs/test-vectors/<category>/*.json},
 * pairs the sibling {@code .bin} when present, and yields {@link Vector}s
 * ordered by name within each category. Mirrors Python's {@code loader.py}
 * and Go's {@code loadCategory}.
 *
 * <p>The corpus root is resolved relative to the Maven working dir
 * ({@code libraries/java/}); override with {@code VSYNC_TEST_VECTORS_DIR}
 * when running against a regenerated corpus.
 */
public final class Loader {

    public static final List<String> CATEGORIES = List.of(
            "rqe1-decrypt",
            "rqe1-decrypt-error",
            "rqem0001-manifest",
            "config-blob",
            "fallback-chain",
            "asset-path",
            "error-taxonomy");

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String CORPUS_REL = "../../docs/specs/test-vectors";

    private Loader() {
    }

    public static Path corpusRoot() {
        String override = System.getenv("VSYNC_TEST_VECTORS_DIR");
        if (override != null && !override.isBlank()) {
            return Paths.get(override).toAbsolutePath().normalize();
        }
        return Paths.get(CORPUS_REL).toAbsolutePath().normalize();
    }

    public static List<Vector> loadCategory(String category) {
        Path dir = corpusRoot().resolve(category);
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        List<Vector> out = new ArrayList<>();
        try (Stream<Path> entries = Files.list(dir)) {
            entries
                    .filter(p -> p.getFileName().toString().endsWith(".json"))
                    .sorted(Comparator.comparing(Path::getFileName))
                    .forEach(jsonPath -> {
                        try {
                            JsonNode meta = MAPPER.readTree(jsonPath.toFile());
                            String name = jsonPath.getFileName().toString()
                                    .replaceFirst("\\.json$", "");
                            Path binPath = jsonPath.resolveSibling(name + ".bin");
                            byte[] binBytes = Files.exists(binPath)
                                    ? Files.readAllBytes(binPath)
                                    : null;
                            out.add(new Vector(category, name, jsonPath,
                                    Files.exists(binPath) ? binPath : null,
                                    binBytes, meta));
                        } catch (IOException e) {
                            throw new RuntimeException(
                                    "loader: " + jsonPath + ": " + e.getMessage(), e);
                        }
                    });
        } catch (IOException e) {
            throw new RuntimeException("loader: " + dir + ": " + e.getMessage(), e);
        }
        return out;
    }

    public static List<Vector> loadAll() {
        List<Vector> out = new ArrayList<>();
        for (String cat : CATEGORIES) {
            out.addAll(loadCategory(cat));
        }
        return out;
    }
}
