package io.github.muthuishere.vsync.s3client.exceptions;

public class ConfigUnsupportedVersionException extends VSyncException {
    public ConfigUnsupportedVersionException(String message) {
        super(message);
    }

    public ConfigUnsupportedVersionException(String message, Throwable cause) {
        super(message, cause);
    }

    public static String canonicalName() {
        return "ConfigUnsupportedVersionError";
    }
}
