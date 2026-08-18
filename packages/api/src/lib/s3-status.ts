export interface S3Config {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Same global operator-level S3 config as packages/operator/src/s3/uploader.ts — the API needs real credentials too, to presign download URLs / read archived logs, not just a yes/no flag. */
export function resolveGlobalS3Config(): S3Config | undefined {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return undefined;
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
  };
}
