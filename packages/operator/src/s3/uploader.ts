export interface S3Config {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Single global operator-level S3 config (plan §4/§3.4): read once from env vars at startup,
 * which charts/a5e/templates/operator-deployment.yaml sources from a Secret. Absent -> logs stay
 * pod-only.
 */
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

/**
 * Uploads run logs using Bun's built-in S3 client (`Bun.S3Client`) — no AWS SDK dependency
 * needed. The operator holds these credentials itself and does the upload after Job completion;
 * run Pods never see them (plan §4.2's credential-isolation rationale — run Pods execute
 * arbitrary user-supplied playbook/git content, so S3 write credentials must stay operator-side).
 */
export async function uploadRunLog(config: S3Config, key: string, content: string): Promise<{ sizeBytes: number }> {
  const client = new Bun.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
  });
  await client.write(key, content);
  return { sizeBytes: Buffer.byteLength(content) };
}
