package io.github.muthuishere.vsync.s3client.exceptions;

public class S3UnreachableException extends VSyncException {
    public S3UnreachableException(String message) {
        super(message);
    }

    public S3UnreachableException(String message, Throwable cause) {
        super(message, cause);
    }

    public static String canonicalName() {
        return "S3UnreachableError";
    }
}
