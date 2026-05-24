package io.github.muthuishere.vsync.s3client.exceptions;

public class UnsupportedSpecVersionException extends VSyncException {
    public UnsupportedSpecVersionException(String message) {
        super(message);
    }

    public UnsupportedSpecVersionException(String message, Throwable cause) {
        super(message, cause);
    }

    public static String canonicalName() {
        return "UnsupportedSpecVersionError";
    }
}
