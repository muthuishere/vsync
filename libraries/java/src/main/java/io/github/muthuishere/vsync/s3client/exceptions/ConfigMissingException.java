package io.github.muthuishere.vsync.s3client.exceptions;

public class ConfigMissingException extends VSyncException {
    public ConfigMissingException(String message) {
        super(message);
    }

    public ConfigMissingException(String message, Throwable cause) {
        super(message, cause);
    }

    public static String canonicalName() {
        return "ConfigMissingError";
    }
}
