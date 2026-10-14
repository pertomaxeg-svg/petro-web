import { createHmac } from "node:crypto";
import { pool } from "@workspace/db";

const SIGN_IN_LIMIT = 10;
const SIGN_IN_WINDOW_SECONDS = 15 * 60;

export function createSignInRateLimitKey(
  ipAddress: string,
  identifier: string,
): string {
  const sessionSecret = process.env["SESSION_SECRET"];
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("Sign-in rate-limit key is unavailable.");
  }

  const normalizedIp = ipAddress.trim() || "unknown";
  const normalizedIdentifier = identifier
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .slice(0, 512);

  return createHmac("sha256", sessionSecret)
    .update("pertomax-eg:sign-in-rate-limit:v1\0")
    .update(normalizedIp)
    .update("\0")
    .update(normalizedIdentifier)
    .digest("hex");
}

export async function consumeSignInAttempt(
  bucketKey: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (!/^[a-f0-9]{64}$/.test(bucketKey)) {
    throw new Error("Invalid sign-in rate-limit key.");
  }

  const result = await pool.query<{
    attempt_count: number;
    retry_after_seconds: number;
  }>(
    `WITH stale AS (
       DELETE FROM petro_private.petro_auth_signin_limits
       WHERE bucket_key IN (
         SELECT bucket_key
         FROM petro_private.petro_auth_signin_limits
         WHERE updated_at < clock_timestamp() - interval '1 day'
           AND bucket_key <> $1
         ORDER BY updated_at
         LIMIT 100
       )
       RETURNING 1
     )
     INSERT INTO petro_private.petro_auth_signin_limits AS current_bucket (
       bucket_key,
       attempt_count,
       window_started_at,
       updated_at
     )
     VALUES ($1, 1, clock_timestamp(), clock_timestamp())
     ON CONFLICT (bucket_key) DO UPDATE
     SET attempt_count = CASE
           WHEN current_bucket.window_started_at
             <= clock_timestamp() - ($2::int * interval '1 second')
             THEN 1
           ELSE LEAST(current_bucket.attempt_count + 1, $3::int + 1)
         END,
         window_started_at = CASE
           WHEN current_bucket.window_started_at
             <= clock_timestamp() - ($2::int * interval '1 second')
             THEN clock_timestamp()
           ELSE current_bucket.window_started_at
         END,
         updated_at = clock_timestamp()
     RETURNING
       attempt_count,
       greatest(
         1,
         ceil(extract(epoch FROM (
           window_started_at
           + ($2::int * interval '1 second')
           - clock_timestamp()
         )))::int
       ) AS retry_after_seconds`,
    [bucketKey, SIGN_IN_WINDOW_SECONDS, SIGN_IN_LIMIT],
  );

  const attemptCount = result.rows[0]?.attempt_count ?? SIGN_IN_LIMIT + 1;
  return {
    allowed: attemptCount <= SIGN_IN_LIMIT,
    retryAfterSeconds: result.rows[0]?.retry_after_seconds ?? SIGN_IN_WINDOW_SECONDS,
  };
}

export async function clearSignInAttempts(bucketKey: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(bucketKey)) {
    throw new Error("Invalid sign-in rate-limit key.");
  }

  await pool.query(
    `DELETE FROM petro_private.petro_auth_signin_limits
     WHERE bucket_key = $1`,
    [bucketKey],
  );
}
