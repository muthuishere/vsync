"""Error taxonomy — class identity is the load-bearing cross-language
contract (v0.12 §11). Names below must match the canonical names that
appear in test-vector JSON files; that's how the conformance suite
matches errors across libs.
"""

from vsync_s3_client import (
    VSyncError,
    ConfigMissingError,
    ConfigUnsupportedVersionError,
    S3UnreachableError,
    ManifestNotFoundError,
    WrongPassphraseError,
    BundleCorruptError,
    UnsupportedSpecVersionError,
)


def test_root_is_vsync_error():
    for cls in (
        ConfigMissingError,
        ConfigUnsupportedVersionError,
        S3UnreachableError,
        ManifestNotFoundError,
        WrongPassphraseError,
        BundleCorruptError,
        UnsupportedSpecVersionError,
    ):
        assert issubclass(cls, VSyncError)
        assert issubclass(cls, Exception)


def test_class_names_match_canonical_taxonomy():
    # Names appear in test-vector JSON `expected.error`; must match exactly.
    assert ConfigMissingError.__name__ == "ConfigMissingError"
    assert ConfigUnsupportedVersionError.__name__ == "ConfigUnsupportedVersionError"
    assert S3UnreachableError.__name__ == "S3UnreachableError"
    assert ManifestNotFoundError.__name__ == "ManifestNotFoundError"
    assert WrongPassphraseError.__name__ == "WrongPassphraseError"
    assert BundleCorruptError.__name__ == "BundleCorruptError"
    assert UnsupportedSpecVersionError.__name__ == "UnsupportedSpecVersionError"


def test_distinct_classes_for_distinct_failures():
    # A caller doing isinstance(e, WrongPassphraseError) must not accidentally
    # catch a BundleCorruptError — these are distinct branches of the tree.
    assert not issubclass(WrongPassphraseError, BundleCorruptError)
    assert not issubclass(BundleCorruptError, WrongPassphraseError)
    assert not issubclass(ConfigMissingError, ConfigUnsupportedVersionError)


def test_carry_message():
    e = WrongPassphraseError("explainer")
    assert str(e) == "explainer"
