package io.github.muthuishere.vsync.s3client.exceptions;

import java.util.Map;

/**
 * Static lookup from a concrete VSync exception class to its cross-language
 * canonical name (v0.12 §11). Used by the conformance loader to compare a
 * thrown exception's class identity against the corpus's
 * {@code expected.error} field. Returns the empty string for any class that
 * isn't one of the 7 canonical subclasses.
 *
 * <p>The taxonomy is fixed; do NOT add new subclasses without also updating
 * the spec and the corpus.
 */
public final class Exceptions {

    private static final Map<Class<? extends VSyncException>, String> CANONICAL_NAMES =
            Map.of(
                    ConfigMissingException.class, "ConfigMissingError",
                    ConfigUnsupportedVersionException.class, "ConfigUnsupportedVersionError",
                    S3UnreachableException.class, "S3UnreachableError",
                    ManifestNotFoundException.class, "ManifestNotFoundError",
                    WrongPassphraseException.class, "WrongPassphraseError",
                    BundleCorruptException.class, "BundleCorruptError",
                    UnsupportedSpecVersionException.class, "UnsupportedSpecVersionError");

    private Exceptions() {
    }

    public static String canonicalNameOf(Class<?> cls) {
        if (cls == null) {
            return "";
        }
        // Walk up the chain so a future caller passing a subtype still resolves.
        for (Class<?> c = cls; c != null; c = c.getSuperclass()) {
            String name = CANONICAL_NAMES.get(c);
            if (name != null) {
                return name;
            }
        }
        return "";
    }

    public static String canonicalNameOf(Throwable t) {
        return t == null ? "" : canonicalNameOf(t.getClass());
    }
}
