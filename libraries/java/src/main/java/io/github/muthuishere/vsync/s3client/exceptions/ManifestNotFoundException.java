package io.github.muthuishere.vsync.s3client.exceptions;

public class ManifestNotFoundException extends VSyncException {
    public ManifestNotFoundException(String message) {
        super(message);
    }

    public ManifestNotFoundException(String message, Throwable cause) {
        super(message, cause);
    }

    public static String canonicalName() {
        return "ManifestNotFoundError";
    }
}
