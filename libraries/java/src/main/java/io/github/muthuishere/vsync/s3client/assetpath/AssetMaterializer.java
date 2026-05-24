package io.github.muthuishere.vsync.s3client.assetpath;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.HashMap;
import java.util.Map;

/**
 * Lazy materialization of vault assets to a per-handle tempdir.
 *
 * <p>Some SDKs only accept a filesystem path ({@code GOOGLE_APPLICATION_CREDENTIALS},
 * OpenSSL cert paths, …). For those, the handle exposes {@code assetPath()} which
 * writes the asset's bytes to a 0600 file inside a 0700 per-handle tempdir and
 * returns the path. {@code assetBytes()} should be the default in new code —
 * it never touches the filesystem.
 *
 * <p>Honest limits: SIGKILL does not run {@link #close()}. A file may leak
 * until next reboot (tmpfs) or until a sweep. v0.12 §6 documents this.
 */
public final class AssetMaterializer implements AutoCloseable {

    private static final FileAttribute<?>[] DIR_PERMS_0700;
    private static final FileAttribute<?>[] FILE_PERMS_0600;

    static {
        boolean posix = isPosix();
        DIR_PERMS_0700 = posix
                ? new FileAttribute<?>[]{
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"))}
                : new FileAttribute<?>[0];
        FILE_PERMS_0600 = posix
                ? new FileAttribute<?>[]{
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))}
                : new FileAttribute<?>[0];
    }

    private Path tempdir;
    private final Map<String, Path> cache = new HashMap<>();
    private boolean closed = false;

    /**
     * Return the per-handle materialization dir, creating it lazily.
     * Mode 0700 on POSIX; the dir name embeds the PID for ad-hoc operator
     * debugging (matches Python / Go / TS). On Linux, prefer {@code /dev/shm}
     * so the bytes stay off the platter.
     */
    private Path ensureDir() {
        if (tempdir != null) {
            return tempdir;
        }
        try {
            String prefix = "vsync-" + ProcessHandle.current().pid() + "-";
            Path base = preferredTempBase();
            if (base != null) {
                tempdir = Files.createTempDirectory(base, prefix, DIR_PERMS_0700);
            } else {
                tempdir = Files.createTempDirectory(prefix, DIR_PERMS_0700);
            }
            // Belt-and-braces re-chmod (some platforms apply umask to the mode arg).
            if (isPosix()) {
                Files.setPosixFilePermissions(tempdir,
                        PosixFilePermissions.fromString("rwx------"));
            }
            return tempdir;
        } catch (IOException e) {
            throw new UncheckedIOException("AssetMaterializer: cannot create tempdir", e);
        }
    }

    public Path materialize(String name, byte[] payload) {
        if (closed) {
            throw new IllegalStateException("AssetMaterializer: already closed");
        }
        Path cached = cache.get(name);
        if (cached != null) {
            return cached;
        }
        // Defang the name: take the basename so a malicious "../../etc/passwd"
        // can't escape the tempdir. Vault contents are operator-trusted but
        // containment is the polite default.
        String safe = sanitizeBasename(name);
        Path dir = ensureDir();
        Path file = dir.resolve(safe);
        try {
            Files.write(file, payload,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.TRUNCATE_EXISTING,
                    StandardOpenOption.WRITE);
            if (isPosix()) {
                Files.setPosixFilePermissions(file,
                        PosixFilePermissions.fromString("rw-------"));
            }
        } catch (IOException e) {
            throw new UncheckedIOException(
                    "AssetMaterializer: write " + safe + " failed", e);
        }
        cache.put(name, file);
        return file;
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        if (tempdir != null) {
            deleteRecursively(tempdir);
            tempdir = null;
        }
        cache.clear();
    }

    private static String sanitizeBasename(String name) {
        if (name == null || name.isEmpty()) {
            return "_asset";
        }
        // Strip path separators on both Unix and Windows so a basename trick
        // doesn't escape the tempdir.
        String basename = name;
        int slash = Math.max(basename.lastIndexOf('/'), basename.lastIndexOf('\\'));
        if (slash >= 0) {
            basename = basename.substring(slash + 1);
        }
        if (basename.isEmpty() || basename.equals(".") || basename.equals("..")) {
            return "_asset";
        }
        return basename;
    }

    private static Path preferredTempBase() {
        // Linux only: /dev/shm is tmpfs — bytes never touch the platter.
        if (System.getProperty("os.name", "").toLowerCase().contains("linux")) {
            Path shm = Paths.get("/dev/shm");
            if (Files.isDirectory(shm)) {
                return shm;
            }
        }
        return null;
    }

    private static boolean isPosix() {
        return java.nio.file.FileSystems.getDefault()
                .supportedFileAttributeViews().contains("posix");
    }

    private static void deleteRecursively(Path dir) {
        try {
            if (!Files.exists(dir)) {
                return;
            }
            Files.walk(dir)
                    .sorted((a, b) -> b.getNameCount() - a.getNameCount())
                    .forEach(p -> {
                        try {
                            Files.deleteIfExists(p);
                        } catch (IOException ignored) {
                            // Best-effort cleanup. The OS will reclaim tmpfs on reboot.
                        }
                    });
        } catch (IOException ignored) {
            // Swallow — process is exiting, OS will reclaim eventually.
        }
    }
}
