package io.github.muthuishere.vsync.s3client.exceptions;

public class BundleCorruptException extends VSyncException {
    public BundleCorruptException(String message) {
        super(message);
    }

    public BundleCorruptException(String message, Throwable cause) {
        super(message, cause);
    }

    public static String canonicalName() {
        return "BundleCorruptError";
    }
}
