import { defineConfig } from "drizzle-kit";
import path from "path";
import { getSupabaseDatabaseConnectionOptions } from "./src/connection";

const connectionOptions = getSupabaseDatabaseConnectionOptions();
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: connectionOptions.connectionString,
    ssl: connectionOptions.ssl,
  },
});
