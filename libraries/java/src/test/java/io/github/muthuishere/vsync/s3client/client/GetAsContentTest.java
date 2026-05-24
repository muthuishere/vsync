package io.github.muthuishere.vsync.s3client.client;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.NoSuchElementException;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * v0.12 §6 — {@code getAsContent} returns raw bytes from the in-memory
 * vault. No filesystem materialization is offered by the library (the
 * deleted {@code assetPath()} and its {@code AssetMaterializer} are gone);
 * operators write a tempfile themselves if an SDK demands a path. These
 * tests pin the bytes-only contract.
 */
class GetAsContentTest {

    @Test
    void returnsBytesFromAssetsMap() {
        byte[] payload = "secret".getBytes(StandardCharsets.UTF_8);
        try (Vsync v = Vsync.fromVaultForTest(
                null, Map.of("svc.json", payload), null, 0, "test")) {
            assertArrayEquals(payload, v.getAsContent("svc.json"));
        }
    }

    @Test
    void fallsBackToKvForUtf8Values() {
        try (Vsync v = Vsync.fromVaultForTest(
                Map.of("PEM_KEY", "-----BEGIN CERTIFICATE-----"),
                null, null, 0, "test")) {
            assertArrayEquals(
                    "-----BEGIN CERTIFICATE-----".getBytes(StandardCharsets.UTF_8),
                    v.getAsContent("PEM_KEY"));
        }
    }

    @Test
    void unknownNameThrows() {
        try (Vsync v = Vsync.fromVaultForTest(null, null, null, 0, "test")) {
            assertThrows(NoSuchElementException.class, () -> v.getAsContent("nope"));
        }
    }

    @Test
    void returnedBytesAreDefensiveCopy() {
        // Callers must not be able to mutate the in-memory vault by editing
        // the returned byte[]. Verify the copy is a fresh array.
        byte[] original = {1, 2, 3};
        try (Vsync v = Vsync.fromVaultForTest(
                null, Map.of("k", original), null, 0, "test")) {
            byte[] a = v.getAsContent("k");
            byte[] b = v.getAsContent("k");
            assertNotSame(a, b);
            a[0] = 99;
            assertArrayEquals(new byte[]{1, 2, 3}, v.getAsContent("k"));
        }
    }

    @Test
    void afterCloseThrows() {
        Vsync v = Vsync.fromVaultForTest(
                null, Map.of("k", new byte[]{1}), null, 0, "test");
        v.close();
        assertThrows(IllegalStateException.class, () -> v.getAsContent("k"));
    }
}
