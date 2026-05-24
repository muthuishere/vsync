package io.github.muthuishere.vsync.s3client.exceptions;

public class WrongPassphraseException extends VSyncException {
    public WrongPassphraseException(String message) {
        super(message);
    }

    public WrongPassphraseException(String message, Throwable cause) {
        super(message, cause);
    }

    public static String canonicalName() {
        return "WrongPassphraseError";
    }
}
