import { Router } from "express";
import { query } from "../db.js";

const router = Router();

// GET /api/todos - list all todos (newest first)
router.get("/", async (_req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT id, title, completed, created_at FROM todos ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/todos - create a todo
router.post("/", async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    const { rows } = await query(
      "INSERT INTO todos (title) VALUES ($1) RETURNING id, title, completed, created_at",
      [title.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/todos/:id - update title and/or completed
router.put("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, completed } = req.body;
    const { rows } = await query(
      `UPDATE todos
         SET title     = COALESCE($1, title),
             completed = COALESCE($2, completed)
       WHERE id = $3
       RETURNING id, title, completed, created_at`,
      [title ?? null, completed ?? null, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "todo not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/:id - remove a todo
router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query("DELETE FROM todos WHERE id = $1", [
      req.params.id,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ error: "todo not found" });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
