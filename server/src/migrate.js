import { pool, query } from "./db.js";

// Creates the todos table if it doesn't exist. Run with: npm run migrate
const schema = `
  CREATE TABLE IF NOT EXISTS todos (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    completed   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function migrate() {
  try {
    await query(schema);
    console.log("Migration complete: 'todos' table is ready.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
