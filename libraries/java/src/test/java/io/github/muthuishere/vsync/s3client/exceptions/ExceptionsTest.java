package io.github.muthuishere.vsync.s3client.exceptions;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Verifies the 7 canonical exception classes (v0.12 §11) and that each
 * exposes its cross-language taxonomy name through {@code canonicalName()}.
 * The conformance loader matches on these names — not on {@code Class.getSimpleName()}
 * (which would be {@code "WrongPassphraseException"}, missing the corpus's
 * {@code "WrongPassphraseError"}).
 */
class ExceptionsTest {

    @Test
    void rootIsVSyncExceptionWithRuntimeBase() {
        VSyncException e = new VSyncException("root");
        assertInstanceOf(RuntimeException.class, e);
        assertEquals("root", e.getMessage());
    }

    @Test
    void configMissingExceptionCanonicalName() {
        assertEquals("ConfigMissingError", ConfigMissingException.canonicalName());
    }

    @Test
    void configUnsupportedVersionExceptionCanonicalName() {
        assertEquals("ConfigUnsupportedVersionError",
                ConfigUnsupportedVersionException.canonicalName());
    }

    @Test
    void s3UnreachableExceptionCanonicalName() {
        assertEquals("S3UnreachableError", S3UnreachableException.canonicalName());
    }

    @Test
    void manifestNotFoundExceptionCanonicalName() {
        assertEquals("ManifestNotFoundError", ManifestNotFoundException.canonicalName());
    }

    @Test
    void wrongPassphraseExceptionCanonicalName() {
        assertEquals("WrongPassphraseError", WrongPassphraseException.canonicalName());
    }

    @Test
    void bundleCorruptExceptionCanonicalName() {
        assertEquals("BundleCorruptError", BundleCorruptException.canonicalName());
    }

    @Test
    void unsupportedSpecVersionExceptionCanonicalName() {
        assertEquals("UnsupportedSpecVersionError",
                UnsupportedSpecVersionException.canonicalName());
    }

    @Test
    void allSubclassesExtendVSyncException() {
        assertInstanceOf(VSyncException.class, new ConfigMissingException("m"));
        assertInstanceOf(VSyncException.class, new ConfigUnsupportedVersionException("m"));
        assertInstanceOf(VSyncException.class, new S3UnreachableException("m"));
        assertInstanceOf(VSyncException.class, new ManifestNotFoundException("m"));
        assertInstanceOf(VSyncException.class, new WrongPassphraseException("m"));
        assertInstanceOf(VSyncException.class, new BundleCorruptException("m"));
        assertInstanceOf(VSyncException.class, new UnsupportedSpecVersionException("m"));
    }

    @Test
    void canonicalNamesViaInstance() {
        VSyncException e = new WrongPassphraseException("x");
        assertEquals("WrongPassphraseError",
                Exceptions.canonicalNameOf(e.getClass()));
    }

    @Test
    void canonicalNameOfNonVsyncClassIsEmpty() {
        assertEquals("", Exceptions.canonicalNameOf(IllegalStateException.class));
    }

    @Test
    void canRetainCause() {
        Throwable cause = new IllegalStateException("root");
        VSyncException e = assertThrows(BundleCorruptException.class, () -> {
            throw new BundleCorruptException("wrap", cause);
        });
        assertEquals(cause, e.getCause());
    }
}
