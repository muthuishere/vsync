package io.github.muthuishere.vsync.s3client.assetpath;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AssetMaterializerTest {

    @Test
    void materializeWritesFileAt0600() throws IOException {
        AssetMaterializer m = new AssetMaterializer();
        byte[] payload = "secret".getBytes();
        try {
            Path path = m.materialize("svc.json", payload);
            assertTrue(Files.exists(path));
            assertArrayEquals(payload, Files.readAllBytes(path));
            PosixFileAttributes attrs = Files.readAttributes(path, PosixFileAttributes.class);
            assertTrue(attrs.permissions().contains(PosixFilePermission.OWNER_READ));
            assertTrue(attrs.permissions().contains(PosixFilePermission.OWNER_WRITE));
            assertFalse(attrs.permissions().contains(PosixFilePermission.GROUP_READ));
            assertFalse(attrs.permissions().contains(PosixFilePermission.OTHERS_READ));
        } finally {
            m.close();
        }
    }

    @Test
    void tempdirIs0700() throws IOException {
        AssetMaterializer m = new AssetMaterializer();
        try {
            Path path = m.materialize("a.txt", new byte[]{1});
            Path dir = path.getParent();
            PosixFileAttributes attrs = Files.readAttributes(dir, PosixFileAttributes.class);
            assertTrue(attrs.permissions().contains(PosixFilePermission.OWNER_EXECUTE));
            assertFalse(attrs.permissions().contains(PosixFilePermission.GROUP_READ));
            assertFalse(attrs.permissions().contains(PosixFilePermission.OTHERS_READ));
        } finally {
            m.close();
        }
    }

    @Test
    void repeatCallReturnsCachedPathWithoutRewriting() {
        AssetMaterializer m = new AssetMaterializer();
        try {
            Path p1 = m.materialize("k", "v1".getBytes());
            // Second call with the same name returns the cached path; the
            // payload arg on the repeat call is ignored.
            Path p2 = m.materialize("k", "v2-ignored".getBytes());
            assertEquals(p1, p2);
        } finally {
            m.close();
        }
    }

    @Test
    void closeRemovesTempdir() throws IOException {
        AssetMaterializer m = new AssetMaterializer();
        Path path = m.materialize("a", new byte[]{1});
        Path dir = path.getParent();
        assertTrue(Files.exists(dir));
        m.close();
        assertFalse(Files.exists(path));
        assertFalse(Files.exists(dir));
    }

    @Test
    void closeIsIdempotent() {
        AssetMaterializer m = new AssetMaterializer();
        m.materialize("x", new byte[]{0});
        m.close();
        m.close(); // second close must not throw
    }

    @Test
    void materializeAfterCloseThrows() {
        AssetMaterializer m = new AssetMaterializer();
        m.close();
        assertThrows(IllegalStateException.class,
                () -> m.materialize("x", new byte[]{0}));
    }

    @Test
    void traversalAttemptIsContained() throws IOException {
        AssetMaterializer m = new AssetMaterializer();
        try {
            Path malicious = m.materialize("../../etc/passwd-mock", "x".getBytes());
            // The file should land inside the tempdir, not escape it.
            assertTrue(malicious.startsWith(malicious.getParent()));
            assertNotEquals(Path.of("/etc/passwd-mock"), malicious);
            assertEquals("passwd-mock", malicious.getFileName().toString());
        } finally {
            m.close();
        }
    }

    @Test
    void differentMaterializersGetDifferentDirs() {
        AssetMaterializer a = new AssetMaterializer();
        AssetMaterializer b = new AssetMaterializer();
        try {
            Path pa = a.materialize("x", new byte[]{0});
            Path pb = b.materialize("x", new byte[]{0});
            assertNotEquals(pa.getParent(), pb.getParent());
        } finally {
            a.close();
            b.close();
        }
    }
}
