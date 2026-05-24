package io.github.muthuishere.vsync.s3client.client;

import io.github.muthuishere.vsync.s3client.config.VsyncConfig;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * v0.12 §12 redaction policy — the handle and VsyncConfig must NOT leak
 * vault values or credentials through any default serialization.
 *
 * <p>"Safe to log" surface: {@link Vsync#envSource}, {@link Vsync#hasEnv},
 * {@link Vsync#generation}. Everything else (getEnv / getAsContent outcomes)
 * is on the caller to keep out of their logger.
 */
class RedactionTest {

    @Test
    void vsyncToStringIsRedactedShape() {
        try (Vsync v = Vsync.fromVaultForTest(
                Map.of("STRIPE_KEY", "sk_live_should_not_appear"),
                Map.of("svc.json", "{\"client_email\":\"hidden\"}".getBytes()),
                Map.of("PORT", "8080"),
                42, "prod")) {
            String s = v.toString();
            assertEquals("<vsync:redacted>", s);
            assertFalse(s.contains("sk_live"), "secret leaked into toString");
            assertFalse(s.contains("hidden"), "asset value leaked into toString");
            assertFalse(s.contains("8080"), "default leaked into toString");
        }
    }

    @Test
    void vsyncConfigToStringRedactsCredentialsAndSalt() {
        VsyncConfig cfg = new VsyncConfig(
                1, "https://s3.example", "us-east-1", "bucket",
                "AKIA-LEAK", "supersecretkey",
                "p/", "prod", "sUperSecretSaltSt", 1000);
        String s = cfg.toString();
        assertFalse(s.contains("AKIA-LEAK"), "access key leaked");
        assertFalse(s.contains("supersecretkey"), "secret access key leaked");
        assertFalse(s.contains("sUperSecretSaltSt"), "salt leaked");
        assertTrue(s.contains("<redacted>"));
        // Non-secret metadata is fine to surface — operators want to see env.
        assertTrue(s.contains("prod"));
        assertTrue(s.contains("bucket"));
    }
}
