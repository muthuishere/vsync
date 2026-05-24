package io.github.muthuishere.vsync.s3client.sources;

import io.github.muthuishere.vsync.s3client.exceptions.ConfigMissingException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class BootstrapSourcesTest {

    @Test
    void neitherSetThrowsConfigMissing() {
        assertThrows(ConfigMissingException.class,
                () -> BootstrapSources.resolve(Map.of()));
    }

    @Test
    void onlyConfigSetMissingPassphraseThrows() {
        assertThrows(ConfigMissingException.class,
                () -> BootstrapSources.resolve(Map.of("VSYNC_CONFIG", "x")));
    }

    @Test
    void onlyPassphraseSetMissingConfigThrows() {
        assertThrows(ConfigMissingException.class,
                () -> BootstrapSources.resolve(Map.of("VSYNC_PASSPHRASE", "x")));
    }

    @Test
    void resolvesFromEnvDirect() {
        BootstrapSources.Resolved r = BootstrapSources.resolve(Map.of(
                "VSYNC_CONFIG", "config-blob",
                "VSYNC_PASSPHRASE", "  pass with leading space"));
        assertArrayEquals("config-blob".getBytes(StandardCharsets.UTF_8), r.configBlob());
        // Env-direct: verbatim, no trim — leading space is part of the passphrase.
        assertEquals("  pass with leading space", r.passphrase());
    }

    @Test
    void resolvesFromFileWithTrimmedTrailingWhitespace(@TempDir Path tmp) throws IOException {
        Path cfg = tmp.resolve("cfg");
        Path pp = tmp.resolve("pp");
        Files.writeString(cfg, "config-blob\n\n", StandardCharsets.UTF_8);
        Files.writeString(pp, "secret-passphrase\r\n", StandardCharsets.UTF_8);
        chmod600(cfg);
        chmod600(pp);
        BootstrapSources.Resolved r = BootstrapSources.resolve(Map.of(
                "VSYNC_CONFIG_FILE", cfg.toString(),
                "VSYNC_PASSPHRASE_FILE", pp.toString()));
        assertArrayEquals("config-blob".getBytes(StandardCharsets.UTF_8), r.configBlob());
        assertEquals("secret-passphrase", r.passphrase());
    }

    @Test
    void fileVariantWinsWhenBothSet(@TempDir Path tmp) throws IOException {
        Path cfg = tmp.resolve("cfg");
        Files.writeString(cfg, "from-file");
        chmod600(cfg);
        Map<String, String> env = new HashMap<>();
        env.put("VSYNC_CONFIG", "from-env");
        env.put("VSYNC_CONFIG_FILE", cfg.toString());
        env.put("VSYNC_PASSPHRASE", "pp");
        BootstrapSources.Resolved r = BootstrapSources.resolve(env);
        assertArrayEquals("from-file".getBytes(StandardCharsets.UTF_8), r.configBlob());
    }

    @Test
    void worldWritableRefuses(@TempDir Path tmp) throws IOException {
        Path cfg = tmp.resolve("cfg");
        Files.writeString(cfg, "x");
        chmod(cfg, "rw-rw-rw-"); // 0666
        Map<String, String> env = Map.of(
                "VSYNC_CONFIG_FILE", cfg.toString(),
                "VSYNC_PASSPHRASE", "pp");
        assertThrows(ConfigMissingException.class,
                () -> BootstrapSources.resolve(env));
    }

    @Test
    void missingFileThrowsConfigMissing(@TempDir Path tmp) {
        Map<String, String> env = Map.of(
                "VSYNC_CONFIG_FILE", tmp.resolve("does-not-exist").toString(),
                "VSYNC_PASSPHRASE", "pp");
        assertThrows(ConfigMissingException.class,
                () -> BootstrapSources.resolve(env));
    }

    @Test
    void groupReadableLogsWarning(@TempDir Path tmp) throws IOException {
        // 0640 — silently allowed but warns on stderr. We don't capture stderr
        // here; just confirm resolve still returns the value.
        Path cfg = tmp.resolve("cfg");
        Files.writeString(cfg, "data");
        chmod(cfg, "rw-r-----"); // 0640
        BootstrapSources.Resolved r = BootstrapSources.resolve(Map.of(
                "VSYNC_CONFIG_FILE", cfg.toString(),
                "VSYNC_PASSPHRASE", "pp"));
        assertArrayEquals("data".getBytes(StandardCharsets.UTF_8), r.configBlob());
    }

    private static void chmod600(Path p) throws IOException {
        Files.setPosixFilePermissions(p, PosixFilePermissions.fromString("rw-------"));
    }

    private static void chmod(Path p, String perms) throws IOException {
        Files.setPosixFilePermissions(p, PosixFilePermissions.fromString(perms));
    }
}
