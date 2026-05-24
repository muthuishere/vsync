package io.github.muthuishere.vsync.s3client.exceptions;

/**
 * Common root for everything raised by this library. Unchecked so the
 * fallback-chain and accessor methods stay ergonomic — callers wrap a
 * single try/catch at the boot path rather than threading checked
 * exceptions through every read.
 *
 * <p>The 7 concrete subclasses (one per row in v0.12 §11) carry the
 * cross-language taxonomy through a {@code canonicalName()} static
 * helper. Conformance-corpus matching is done via that name, not via
 * Java's {@code Class.getSimpleName()} — Java idiom says {@code Exception},
 * the spec says {@code Error}.
 */
public class VSyncException extends RuntimeException {
    public VSyncException(String message) {
        super(message);
    }

    public VSyncException(String message, Throwable cause) {
        super(message, cause);
    }
}
