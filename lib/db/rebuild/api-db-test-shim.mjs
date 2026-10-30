import pg from "pg";

const { Pool } = pg;

if (!process.env["PGHOST"] || !process.env["PGPORT"] || !process.env["PGDATABASE"]) {
  throw new Error("The isolated API database harness requires its temporary PGHOST, PGPORT, and PGDATABASE.");
}

export const pool = new Pool({
  host: process.env["PGHOST"],
  port: Number(process.env["PGPORT"]),
  database: process.env["PGDATABASE"],
  user: process.env["PGUSER"] ?? "postgres",
  connectionTimeoutMillis: 5_000,
});
