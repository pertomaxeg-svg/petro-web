import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { getSupabaseDatabaseConnectionOptions } from "./connection";

const { Pool } = pg;
const connectionOptions = getSupabaseDatabaseConnectionOptions();

export const pool = new Pool({
  ...connectionOptions,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
