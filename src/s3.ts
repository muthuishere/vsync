// Bun S3 client wrapper. Credentials come from the decoded VIDEO_AI_ENV_<NAME>
// blob; see src/envconfig.ts.

export type S3Credentials = {
  endpoint: string;
  region: string;
  useSsl: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export function makeClient(creds: S3Credentials) {
  const protocol = creds.useSsl ? "https://" : "http://";
  const endpoint = creds.endpoint.startsWith("http")
    ? creds.endpoint
    : protocol + creds.endpoint;
  return new Bun.S3Client({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region,
    bucket: creds.bucket,
    endpoint,
  });
}
