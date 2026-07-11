import express from "express";
import cors from "cors";
import "dotenv/config";

import todosRouter from "./routes/todos.js";
import { pool } from "./db.js";

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", db: "unreachable" });
  }
});

app.use("/api/todos", todosRouter);

// Central error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

const port = Number(process.env.PORT) || 8000;
app.listen(port, async () => {
  console.log(`Todo API listening on http://localhost:${port}`);

  // Verify the database is reachable and report it in the startup logs.
  try {
    await pool.query("SELECT 1");
    console.log(`DB connection: OK (${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE})`);
  } catch (err) {
    console.error(`DB connection: FAILED (${process.env.PGHOST}:${process.env.PGPORT}) - ${err.message}`);
  }
});
