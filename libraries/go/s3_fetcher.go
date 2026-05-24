package vsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	awsConfig "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithy "github.com/aws/smithy-go"
)

// defaultFetcher is the production Fetcher — one S3 round-trip via
// aws-sdk-go-v2. Tests inject a fake via WithFetcher and never reach
// this code path; the conformance suite operates purely on bytes.
type defaultFetcher struct{}

func (defaultFetcher) Fetch(ctx context.Context, cfg *Config) (manifestBytes []byte, bundleBytes []byte, generation int, err error) {
	client := s3.NewFromConfig(awsConfig.Config{
		Region:      cfg.Region,
		Credentials: credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
	}, func(o *s3.Options) {
		o.UsePathStyle = true
		if cfg.Endpoint != "" {
			o.BaseEndpoint = stringPtr(cfg.Endpoint)
		}
	})

	manifestKey := cfg.Prefix + "manifest"
	manifestBytes, err = s3Get(ctx, client, cfg.Bucket, manifestKey)
	if err != nil {
		return nil, nil, 0, classifyS3Err(err, manifestKey)
	}
	ts, _, err := UnwrapRQEM0001(manifestBytes)
	if err != nil {
		return nil, nil, 0, err
	}
	bundleKey := cfg.Prefix + "v=" + ts
	bundleBytes, err = s3Get(ctx, client, cfg.Bucket, bundleKey)
	if err != nil {
		// Manifest pointed at a 404 → torn bucket state, not a network
		// problem. Surface as BundleCorrupt so the operator's recourse
		// is `vsync push` rather than firewall diagnostics.
		if isNotFound(err) {
			return nil, nil, 0, fmt.Errorf("%w: manifest points at s3://%s/%s but the object is 404",
				ErrBundleCorrupt, cfg.Bucket, bundleKey)
		}
		return nil, nil, 0, classifyS3Err(err, bundleKey)
	}

	// Optional gen counter — absent on pre-rotation bundles, so 404 is fine.
	gen := 0
	metaBytes, metaErr := s3Get(ctx, client, cfg.Bucket, cfg.Prefix+"latest.meta")
	if metaErr == nil {
		var meta struct {
			Gen int `json:"gen"`
		}
		if json.Unmarshal(metaBytes, &meta) == nil {
			gen = meta.Gen
		}
	}
	return manifestBytes, bundleBytes, gen, nil
}

func s3Get(ctx context.Context, client *s3.Client, bucket, key string) ([]byte, error) {
	resp, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: stringPtr(bucket),
		Key:    stringPtr(key),
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func isNotFound(err error) bool {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		code := apiErr.ErrorCode()
		return code == "NoSuchKey" || code == "NotFound" || code == "404"
	}
	return false
}

func classifyS3Err(err error, key string) error {
	if isNotFound(err) {
		return fmt.Errorf("%w: object %q is 404 — run `vsync push <env>` first", ErrManifestNotFound, key)
	}
	return fmt.Errorf("%w: cannot read %q: %v", ErrS3Unreachable, key, err)
}

func stringPtr(s string) *string { return &s }
