package io.github.muthuishere.vsync.s3client.client;

import io.github.muthuishere.vsync.s3client.config.VsyncConfig;
import io.github.muthuishere.vsync.s3client.exceptions.ManifestNotFoundException;
import io.github.muthuishere.vsync.s3client.exceptions.S3UnreachableException;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.NoSuchElementException;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VsyncTest {

    @Test
    void getReturnsVaultValue() {
        Vsync v = Vsync.fromVaultForTest(
                Map.of("DATABASE_URL", "postgres://vault"),
                null, null, 0, "test");
        assertEquals("postgres://vault", v.get("DATABASE_URL").orElseThrow());
        assertEquals(Source.VAULT, v.source("DATABASE_URL"));
        assertTrue(v.has("DATABASE_URL"));
        v.close();
    }

    @Test
    void fallsBackToProcessEnv() {
        // PATH is always set on macOS / Linux; on Windows tests skip this fallback.
        String envKey = "PATH";
        if (System.getenv(envKey) == null) {
            return;
        }
        Vsync v = Vsync.fromVaultForTest(null, null, null, 0, "test");
        assertEquals(System.getenv(envKey), v.get(envKey).orElseThrow());
        assertEquals(Source.ENV, v.source(envKey));
        v.close();
    }

    @Test
    void fallsBackToDefaults() {
        Vsync v = Vsync.fromVaultForTest(
                null, null,
                Map.of("PORT", "8080"),
                0, "test");
        assertEquals("8080", v.get("PORT").orElseThrow());
        assertEquals(Source.DEFAULT, v.source("PORT"));
        v.close();
    }

    @Test
    void missingKeyReturnsEmptyAndMissingSource() {
        Vsync v = Vsync.fromVaultForTest(null, null, null, 0, "test");
        // Use a name that's almost certainly not in the process env to avoid
        // leakage from CI runners.
        String key = "VSYNC_TEST_DEFINITELY_UNSET_" + System.nanoTime();
        assertFalse(v.has(key));
        assertTrue(v.get(key).isEmpty());
        assertEquals(Source.MISSING, v.source(key));
        v.close();
    }

    @Test
    void vaultBeatsEnvBeatsDefaults() {
        // Set "PATH" both in vault and defaults — vault wins.
        Vsync v = Vsync.fromVaultForTest(
                Map.of("PATH", "vault-path"),
                null,
                Map.of("PATH", "default-path"),
                0, "test");
        assertEquals("vault-path", v.get("PATH").orElseThrow());
        assertEquals(Source.VAULT, v.source("PATH"));
        v.close();
    }

    @Test
    void assetBytesReturnsRawBytes() {
        byte[] payload = {1, 2, 3, 4};
        Vsync v = Vsync.fromVaultForTest(
                null,
                Map.of("svc.json", payload),
                null, 0, "test");
        assertArrayEquals(payload, v.assetBytes("svc.json"));
        v.close();
    }

    @Test
    void assetBytesFallsBackToKvForUtf8Values() {
        Vsync v = Vsync.fromVaultForTest(
                Map.of("PEM_KEY", "-----BEGIN CERTIFICATE-----"),
                null, null, 0, "test");
        assertArrayEquals(
                "-----BEGIN CERTIFICATE-----".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                v.assetBytes("PEM_KEY"));
        v.close();
    }

    @Test
    void assetBytesUnknownThrows() {
        Vsync v = Vsync.fromVaultForTest(null, null, null, 0, "test");
        assertThrows(NoSuchElementException.class, () -> v.assetBytes("nope"));
        v.close();
    }

    @Test
    void assetPathMaterializesFile() throws Exception {
        byte[] payload = {9, 8, 7};
        Vsync v = Vsync.fromVaultForTest(null,
                Map.of("a.bin", payload), null, 0, "test");
        Path p = v.assetPath("a.bin");
        assertTrue(Files.exists(p));
        assertArrayEquals(payload, Files.readAllBytes(p));
        v.close();
        assertFalse(Files.exists(p));
    }

    @Test
    void closeIsIdempotent() {
        Vsync v = Vsync.fromVaultForTest(Map.of("k", "v"), null, null, 0, "test");
        v.close();
        v.close();
        assertTrue(v.isClosed());
    }

    @Test
    void usingAfterCloseThrows() {
        Vsync v = Vsync.fromVaultForTest(Map.of("k", "v"), null, null, 0, "test");
        v.close();
        assertThrows(IllegalStateException.class, () -> v.get("k"));
        assertThrows(IllegalStateException.class, () -> v.has("k"));
        assertThrows(IllegalStateException.class, () -> v.source("k"));
    }

    @Test
    void tryWithResourcesClosesHandle() {
        Vsync ref;
        try (Vsync v = Vsync.fromVaultForTest(Map.of("k", "v"), null, null, 0, "test")) {
            ref = v;
            assertEquals("v", v.get("k").orElseThrow());
        }
        assertTrue(ref.isClosed());
    }

    @Test
    void generationIsExposed() {
        Vsync v = Vsync.fromVaultForTest(null, null, null, 42, "prod");
        assertEquals(42, v.generation());
        assertEquals("prod", v.env());
        v.close();
    }

    @Test
    void mutatingAssetBytesDoesNotAffectVault() {
        byte[] original = {1, 2, 3};
        Vsync v = Vsync.fromVaultForTest(null,
                Map.of("k", original), null, 0, "test");
        byte[] view = v.assetBytes("k");
        view[0] = 99;
        // Re-read; original should still be intact.
        assertArrayEquals(new byte[]{1, 2, 3}, v.assetBytes("k"));
        v.close();
    }

    @Test
    void mutableMapsArePassedSafely() {
        // Caller mutating the input map after construction must NOT change the handle.
        Map<String, String> kv = new HashMap<>();
        kv.put("k", "v");
        Vsync v = Vsync.fromVaultForTest(kv, null, null, 0, "test");
        kv.put("k", "mutated");
        assertEquals("v", v.get("k").orElseThrow());
        v.close();
    }

    @Test
    void hasReturnsFalseAfterClose() {
        // The closed-handle policy is to throw on use; this test exists to pin
        // the choice (i.e., if a future refactor swaps throw → return false,
        // the test should be updated, not the lib).
        Vsync v = Vsync.fromVaultForTest(Map.of("k", "v"), null, null, 0, "test");
        v.close();
        assertThrows(IllegalStateException.class, () -> v.has("k"));
    }

    @Test
    void toStringIsRedacted() {
        Vsync v = Vsync.fromVaultForTest(
                Map.of("DATABASE_URL", "postgres://secret:hidden@host/db"),
                null, null, 5, "prod");
        String s = v.toString();
        assertEquals("<vsync:redacted>", s);
        v.close();
    }

    @Test
    void assetPathNullMaterializerHandlesGracefully() {
        // Closing without ever calling assetPath() must not blow up.
        Vsync v = Vsync.fromVaultForTest(Map.of("k", "v"), null, null, 0, "test");
        assertNotNull(v);
        v.close();
    }

    // ─── remoteGeneration / hasNewVersion (v0.12 §4.4, §4.5, §7.1) ─────────

    private static VsyncConfig stubCfg() {
        return new VsyncConfig(
                1, "https://s3.example", "us-east-1", "b",
                "k", "s", "myapp/prod/", "prod",
                "abcdefghijklmnopqrstuv", 1000);
    }

    /** Stateful fetcher whose {@code fetchGeneration} returns a separately-controlled value. */
    private static final class StubFetcher implements S3Fetcher {
        long genForRemote;
        boolean throwUnreachable;
        boolean throwManifestNotFound;

        @Override
        public Fetched fetch(VsyncConfig cfg) {
            throw new UnsupportedOperationException(
                    "this stub only services fetchGeneration() — open() not exercised here");
        }

        @Override
        public long fetchGeneration(VsyncConfig cfg) {
            if (throwUnreachable) {
                throw new S3UnreachableException("simulated network down");
            }
            if (throwManifestNotFound) {
                throw new ManifestNotFoundException("simulated 404");
            }
            return genForRemote;
        }
    }

    @Test
    void remoteGenerationReturnsRemoteGenLocalUntouched() {
        StubFetcher fetcher = new StubFetcher();
        fetcher.genForRemote = 7L;
        // Local gen captured at open == 5; remote answers 7.
        Vsync v = Vsync.fromVaultForTest(null, null, null, 5, "prod",
                fetcher, stubCfg());
        assertEquals(5L, v.generation());
        assertEquals(7L, v.remoteGeneration());
        // Polling MUST NOT mutate the local generation (v0.12 §4.5).
        assertEquals(5L, v.generation());
        v.close();
    }

    @Test
    void remoteGenerationThrowsS3UnreachableOnNetworkFailure() {
        StubFetcher fetcher = new StubFetcher();
        fetcher.throwUnreachable = true;
        Vsync v = Vsync.fromVaultForTest(null, null, null, 5, "prod",
                fetcher, stubCfg());
        assertThrows(S3UnreachableException.class, v::remoteGeneration);
        v.close();
    }

    @Test
    void remoteGenerationThrowsManifestNotFoundOn404() {
        StubFetcher fetcher = new StubFetcher();
        fetcher.throwManifestNotFound = true;
        Vsync v = Vsync.fromVaultForTest(null, null, null, 5, "prod",
                fetcher, stubCfg());
        assertThrows(ManifestNotFoundException.class, v::remoteGeneration);
        v.close();
    }

    @Test
    void hasNewVersionTrueWhenLocalBehind() {
        StubFetcher fetcher = new StubFetcher();
        fetcher.genForRemote = 4L;
        Vsync v = Vsync.fromVaultForTest(null, null, null, 3, "prod",
                fetcher, stubCfg());
        assertTrue(v.hasNewVersion());
        v.close();
    }

    @Test
    void hasNewVersionFalseWhenLocalCurrent() {
        StubFetcher fetcher = new StubFetcher();
        fetcher.genForRemote = 5L;
        Vsync v = Vsync.fromVaultForTest(null, null, null, 5, "prod",
                fetcher, stubCfg());
        assertFalse(v.hasNewVersion());
        v.close();
    }

    @Test
    void hasNewVersionFalseWhenLocalAhead() {
        // Theoretical "gen went backward" case — never expected in practice,
        // but the contract is strictly `remote > local`, so this must be false.
        StubFetcher fetcher = new StubFetcher();
        fetcher.genForRemote = 8L;
        Vsync v = Vsync.fromVaultForTest(null, null, null, 10, "prod",
                fetcher, stubCfg());
        assertFalse(v.hasNewVersion());
        v.close();
    }
}
