package io.github.muthuishere.vsync.s3client.sources;

import io.github.muthuishere.vsync.s3client.exceptions.ConfigMissingException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Map;
import java.util.Set;

/**
 * Two-input bootstrap resolution for {@code VSYNC_CONFIG} + {@code VSYNC_PASSPHRASE}.
 *
 * <p>Per v0.12 §2:
 * <ul>
 *   <li>{@code _FILE} variant wins if both forms are set.</li>
 *   <li>Env-direct value is verbatim; file value has trailing whitespace stripped.</li>
 *   <li>Neither form set → {@link ConfigMissingException}.</li>
 * </ul>
 *
 * <p>Per v0.12 §13 (file-permissions policy):
 * <ul>
 *   <li>0600 / 0400 → silent read.</li>
 *   <li>0644 / 0640 (group/world readable) → read + warn on stderr.</li>
 *   <li>0666 / 0777 (world-writable) → refuse → {@link ConfigMissingException}.</li>
 *   <li>ENOENT / EACCES → {@link ConfigMissingException} with hint.</li>
 * </ul>
 *
 * <p>On Windows, the permission check is skipped (POSIX mode bits are meaningless
 * there). The library logs that decision on stderr so it shows up in deploy logs.
 */
public final class BootstrapSources {

    public static final String ENV_CONFIG = "VSYNC_CONFIG";
    public static final String ENV_CONFIG_FILE = "VSYNC_CONFIG_FILE";
    public static final String ENV_PASSPHRASE = "VSYNC_PASSPHRASE";
    public static final String ENV_PASSPHRASE_FILE = "VSYNC_PASSPHRASE_FILE";

    private BootstrapSources() {
    }

    public record Resolved(byte[] configBlob, String passphrase) {
    }

    public static Resolved resolve() {
        return resolve(System.getenv());
    }

    public static Resolved resolve(Map<String, String> env) {
        byte[] config = resolveOne(env, ENV_CONFIG, ENV_CONFIG_FILE);
        if (config == null) {
            throw new ConfigMissingException(
                    "vsync: neither " + ENV_CONFIG + " nor " + ENV_CONFIG_FILE
                            + " is set — fix the deploy config (v0.12 §2)");
        }
        byte[] pp = resolveOne(env, ENV_PASSPHRASE, ENV_PASSPHRASE_FILE);
        if (pp == null) {
            throw new ConfigMissingException(
                    "vsync: neither " + ENV_PASSPHRASE + " nor " + ENV_PASSPHRASE_FILE
                            + " is set — fix the deploy config (v0.12 §2)");
        }
        // Passphrase is text; surfaces UTF-8 decode failure as ConfigMissing (operator config error).
        try {
            return new Resolved(config, new String(pp, StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new ConfigMissingException(
                    "vsync: " + ENV_PASSPHRASE_FILE + " contents are not UTF-8 — passphrases must be UTF-8", e);
        }
    }

    private static byte[] resolveOne(Map<String, String> env, String envName, String fileName) {
        String filePath = env.get(fileName);
        if (filePath != null && !filePath.isEmpty()) {
            return readPolicyChecked(filePath);
        }
        String value = env.get(envName);
        if (value != null) {
            return value.getBytes(StandardCharsets.UTF_8);
        }
        return null;
    }

    private static byte[] readPolicyChecked(String pathString) {
        Path path = Path.of(pathString);
        if (isWindows()) {
            System.err.println("vsync: file-permission check skipped (Windows)");
        } else {
            checkPosixPermissions(path);
        }
        byte[] data;
        try {
            data = Files.readAllBytes(path);
        } catch (java.nio.file.NoSuchFileException e) {
            throw new ConfigMissingException(
                    "vsync: " + pathString + " does not exist — fix the deploy config", e);
        } catch (java.nio.file.AccessDeniedException e) {
            throw new ConfigMissingException(
                    "vsync: cannot read " + pathString + ": permission denied", e);
        } catch (IOException e) {
            throw new ConfigMissingException(
                    "vsync: cannot read " + pathString + ": " + e.getMessage(), e);
        }
        // Strip trailing whitespace (CRLF, LF, tab, space) per v0.12 §2.
        int end = data.length;
        while (end > 0) {
            byte b = data[end - 1];
            if (b == '\r' || b == '\n' || b == '\t' || b == ' ') {
                end--;
            } else {
                break;
            }
        }
        if (end == data.length) {
            return data;
        }
        byte[] trimmed = new byte[end];
        System.arraycopy(data, 0, trimmed, 0, end);
        return trimmed;
    }

    private static void checkPosixPermissions(Path path) {
        Set<PosixFilePermission> perms;
        try {
            PosixFileAttributes attrs = Files.readAttributes(path, PosixFileAttributes.class);
            perms = attrs.permissions();
        } catch (java.nio.file.NoSuchFileException e) {
            throw new ConfigMissingException(
                    "vsync: " + path + " does not exist — fix the deploy config", e);
        } catch (UnsupportedOperationException e) {
            // POSIX view not supported (e.g. non-Unix filesystem on a Unix host).
            // Treat as Windows-style: skip the check and continue.
            System.err.println("vsync: POSIX permission check unavailable for " + path);
            return;
        } catch (IOException e) {
            throw new ConfigMissingException(
                    "vsync: cannot stat " + path + ": " + e.getMessage(), e);
        }
        int mode = toOctalMode(perms);
        // World-writable bit = 0002 (octal).
        if ((mode & 02) != 0) {
            throw new ConfigMissingException(
                    "vsync: refusing to read world-writable file " + path
                            + " (mode 0" + Integer.toOctalString(mode) + "); narrow to 0600");
        }
        // Group-readable (040) or world-readable (004).
        if ((mode & 044) != 0) {
            System.err.println("vsync: " + path
                    + " is world/group-readable (mode 0" + Integer.toOctalString(mode)
                    + "); narrow to 0600");
        }
    }

    private static int toOctalMode(Set<PosixFilePermission> perms) {
        int mode = 0;
        if (perms.contains(PosixFilePermission.OWNER_READ))     mode |= 0400;
        if (perms.contains(PosixFilePermission.OWNER_WRITE))    mode |= 0200;
        if (perms.contains(PosixFilePermission.OWNER_EXECUTE))  mode |= 0100;
        if (perms.contains(PosixFilePermission.GROUP_READ))     mode |= 040;
        if (perms.contains(PosixFilePermission.GROUP_WRITE))    mode |= 020;
        if (perms.contains(PosixFilePermission.GROUP_EXECUTE))  mode |= 010;
        if (perms.contains(PosixFilePermission.OTHERS_READ))    mode |= 04;
        if (perms.contains(PosixFilePermission.OTHERS_WRITE))   mode |= 02;
        if (perms.contains(PosixFilePermission.OTHERS_EXECUTE)) mode |= 01;
        return mode;
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }
}
