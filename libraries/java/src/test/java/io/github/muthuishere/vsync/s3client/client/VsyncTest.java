package io.github.muthuishere.vsync.s3client.client;

import io.github.muthuishere.vsync.s3client.config.VsyncConfig;
import io.github.muthuishere.vsync.s3client.exceptions.ManifestNotFoundException;
import io.github.muthuishere.vsync.s3client.exceptions.S3UnreachableException;
import org.junit.jupiter.api.Test;

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
    void getEnvReturnsVaultValue() {
        Vsync v = Vsync.fromVaultForTest(
                Map.of("DATABASE_URL", "postgres://vault"),
                null, null, 0, "test");
        assertEquals("postgres://vault", v.getEnv("DATABASE_URL"));
        assertEquals(Source.VAULT, v.envSource("DATABASE_URL"));
        assertTrue(v.hasEnv("DATABASE_URL"));
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
        assertEquals(System.getenv(envKey), v.getEnv(envKey));
        assertEquals(Source.ENV, v.envSource(envKey));
        v.close();
    }

    @Test
    void fallsBackToDefaults() {
        Vsync v = Vsync.fromVaultForTest(
                null, null,
                Map.of("PORT", "8080"),
                0, "test");
        assertEquals("8080", v.getEnv("PORT"));
        assertEquals(Source.DEFAULT, v.envSource("PORT"));
        v.close();
    }

    @Test
    void missingKeyReturnsNullAndMissingSource() {
        Vsync v = Vsync.fromVaultForTest(null, null, null, 0, "test");
        String key = "VSYNC_TEST_DEFINITELY_UNSET_" + System.nanoTime();
        assertFalse(v.hasEnv(key));
        assertEquals(null, v.getEnv(key));
        assertEquals(Source.MISSING, v.envSource(key));
        v.close();
    }

    @Test
    void vaultBeatsEnvBeatsDefaults() {
        Vsync v = Vsync.fromVaultForTest(
                Map.of("PATH", "vault-path"),
                null,
                Map.of("PATH", "default-path"),
                0, "test");
        assertEquals("vault-path", v.getEnv("PATH"));
        assertEquals(Source.VAULT, v.envSource("PATH"));
        v.close();
    }

    @Test
    void getAsContentReturnsRawBytes() {
        byte[] payload = {1, 2, 3, 4};
        Vsync v = Vsync.fromVaultForTest(
                null,
                Map.of("svc.json", payload),
                null, 0, "test");
        assertArrayEquals(payload, v.getAsContent("svc.json"));
        v.close();
    }

    @Test
    void getAsContentFallsBackToKvForUtf8Values() {
        Vsync v = Vsync.fromVaultForTest(
                Map.of("PEM_KEY", "-----BEGIN CERTIFICATE-----"),
                null, null, 0, "test");
        assertArrayEquals(
                "-----BEGIN CERTIFICATE-----".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                v.getAsContent("PEM_KEY"));
        v.close();
    }

    @Test
    void getAsContentUnknownThrows() {
        Vsync v = Vsync.fromVaultForTest(null, null, null, 0, "test");
        assertThrows(NoSuchElementException.class, () -> v.getAsContent("nope"));
        v.close();
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
        assertThrows(IllegalStateException.class, () -> v.getEnv("k"));
        assertThrows(IllegalStateException.class, () -> v.hasEnv("k"));
        assertThrows(IllegalStateException.class, () -> v.envSource("k"));
    }

    @Test
    void tryWithResourcesClosesHandle() {
        Vsync ref;
        try (Vsync v = Vsync.fromVaultForTest(Map.of("k", "v"), null, null, 0, "test")) {
            ref = v;
            assertEquals("v", v.getEnv("k"));
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
    void mutatingGetAsContentDoesNotAffectVault() {
        byte[] original = {1, 2, 3};
        Vsync v = Vsync.fromVaultForTest(null,
                Map.of("k", original), null, 0, "test");
        byte[] view = v.getAsContent("k");
        view[0] = 99;
        assertArrayEquals(new byte[]{1, 2, 3}, v.getAsContent("k"));
        v.close();
    }

    @Test
    void mutableMapsArePassedSafely() {
        Map<String, String> kv = new HashMap<>();
        kv.put("k", "v");
        Vsync v = Vsync.fromVaultForTest(kv, null, null, 0, "test");
        kv.put("k", "mutated");
        assertEquals("v", v.getEnv("k"));
        v.close();
    }

    @Test
    void hasEnvThrowsAfterClose() {
        // The closed-handle policy is to throw on use; this test exists to pin
        // the choice (i.e., if a future refactor swaps throw → return false,
        // the test should be updated, not the lib).
        Vsync v = Vsync.fromVaultForTest(Map.of("k", "v"), null, null, 0, "test");
        v.close();
        assertThrows(IllegalStateException.class, () -> v.hasEnv("k"));
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
    void closeWithoutGetAsContentCallsHandlesGracefully() {
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
        Vsync v = Vsync.fromVaultForTest(null, null, null, 5, "prod",
                fetcher, stubCfg());
        assertEquals(5L, v.generation());
        assertEquals(7L, v.remoteGeneration());
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
        StubFetcher fetcher = new StubFetcher();
        fetcher.genForRemote = 8L;
        Vsync v = Vsync.fromVaultForTest(null, null, null, 10, "prod",
                fetcher, stubCfg());
        assertFalse(v.hasNewVersion());
        v.close();
    }
}
