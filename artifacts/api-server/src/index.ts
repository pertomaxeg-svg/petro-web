import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const port = Number(process.env["PORT"] ?? 5001);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

function getSafeDatabaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
    ? code
    : undefined;
}

async function checkSupabasePostgresConnection(): Promise<void> {
  let releaseClient: (() => void) | undefined;
  try {
    const client = await pool.connect();
    releaseClient = () => client.release();
    logger.info(
      { connection: "supabase-postgresql" },
      "Supabase PostgreSQL connection established",
    );
  } catch (error) {
    logger.error(
      { errorCode: getSafeDatabaseErrorCode(error) },
      "Supabase PostgreSQL connection failed; API will start without database access",
    );
  } finally {
    releaseClient?.();
  }
}

await checkSupabasePostgresConnection();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
