import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// Connection settings are read from .env (see .env.example).
// The `pg` library also reads PG* env vars natively, but we pass them
// explicitly here so SSL and pool sizing stay under our control.
export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  // RDS enforces TLS; enable it with PGSSL=true. rejectUnauthorized:false
  // avoids bundling the RDS CA for a simple setup — tighten for production.
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Thin query helper so routes don't import Pool directly.
export const query = (text, params) => pool.query(text, params);
