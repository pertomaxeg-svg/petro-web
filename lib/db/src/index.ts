import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { getSupabaseDatabaseUrl } from "./connection";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: getSupabaseDatabaseUrl(),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
