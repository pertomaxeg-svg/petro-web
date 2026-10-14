const APPROVED_SUPABASE_PROJECT_REF = "msvgzsfzrqlrfpstthhe";
const DIRECT_DATABASE_HOST =
  `db.${APPROVED_SUPABASE_PROJECT_REF}.supabase.co`;
const POOLER_HOST_SUFFIX = ".pooler.supabase.com";
const REQUIRED_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);

export function getSupabaseDatabaseUrl(): string {
  const connectionString = process.env["SUPABASE_DB_URL"]?.trim();
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DB_URL must be set to the approved Supabase PostgreSQL connection string.",
    );
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error("SUPABASE_DB_URL must be a valid PostgreSQL URL.");
  }

  if (
    databaseUrl.protocol !== "postgres:" &&
    databaseUrl.protocol !== "postgresql:"
  ) {
    throw new Error("SUPABASE_DB_URL must use the PostgreSQL protocol.");
  }

  const usesApprovedDirectHost =
    databaseUrl.hostname.toLowerCase() === DIRECT_DATABASE_HOST;
  const poolerUsernameParts = decodeURIComponent(databaseUrl.username).split(
    ".",
  );
  const usesApprovedPooler =
    databaseUrl.hostname.toLowerCase().endsWith(POOLER_HOST_SUFFIX) &&
    poolerUsernameParts.includes(APPROVED_SUPABASE_PROJECT_REF);

  if (!usesApprovedDirectHost && !usesApprovedPooler) {
    throw new Error(
      "SUPABASE_DB_URL does not identify the approved Supabase project.",
    );
  }

  if (!databaseUrl.username || !databaseUrl.password) {
    throw new Error(
      "SUPABASE_DB_URL must include the PostgreSQL username and password.",
    );
  }

  const sslMode = databaseUrl.searchParams.get("sslmode")?.toLowerCase();
  if (!sslMode || !REQUIRED_SSL_MODES.has(sslMode)) {
    throw new Error(
      "SUPABASE_DB_URL must require SSL. Copy the Supabase connection URI with SSL enabled.",
    );
  }

  return connectionString;
}
