import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --------------------
// Database connection
// --------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
});

// --------------------
// Health check
// --------------------
app.get("/api/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows[0].ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================================================
// READ endpoints (used by website)
// =========================================================

// GET mazes
app.get("/api/mazes", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM Maze ORDER BY maze_id`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET algorithms
app.get("/api/algorithms", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM Algorithm ORDER BY algorithm_id`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET teams + members (nested)
app.get("/api/teams", async (req, res) => {
  try {
    const [teams] = await pool.query(`SELECT * FROM team ORDER BY team_code`);
    const [members] = await pool.query(`SELECT * FROM team_member ORDER BY team_id, member_id`);

    const membersByTeam = new Map();
    for (const m of members) {
      if (!membersByTeam.has(m.team_id)) membersByTeam.set(m.team_id, []);
      membersByTeam.get(m.team_id).push(m);
    }

    const result = teams.map((t) => ({
      ...t,
      members: membersByTeam.get(t.team_id) || [],
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET runs (joined for UI display)
app.get("/api/runs", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        r.run_id,
        r.run_time,
        r.path_length,
        r.goal_reached,
        r.nodes_explored,
        r.date,
        r.notes,

        r.maze_id,
        m.goal_type,
        m.no_of_tiles,

        r.algorithm_id,
        a.type AS algorithm_type,

        t.team_code,
        t.team_name,
        t.contact_email,

        c.car_name,
        c.car_type

      FROM Run r
      JOIN Maze m ON r.maze_id = m.maze_id
      JOIN Algorithm a ON r.algorithm_id = a.algorithm_id
      LEFT JOIN team t ON r.team_id = t.team_id
      LEFT JOIN car c ON r.car_id = c.car_id
      ORDER BY r.date DESC, r.run_id DESC
      LIMIT 200
    `);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
// WRITE endpoints (used by robot + website forms)
// =========================================================

// POST run (robot OR website "New Run" form)
app.post("/api/runs", async (req, res) => {
  try {
    const {
      run_id,
      maze_id,
      algorithm_id,
      run_time,
      path_length,
      goal_reached,
      nodes_explored,
      date,
      notes,
      team_code, // optional: allow team_code instead of team_id
    } = req.body;

    if (!run_id || !maze_id || !algorithm_id || run_time == null) {
      return res.status(400).json({
        error: "Required: run_id, maze_id, algorithm_id, run_time",
      });
    }

    // Convert team_code -> team_id and set car_id automatically (simple)
    let team_id = null;
    let car_id = null;

    if (team_code) {
      const [teamRows] = await pool.query(
        `SELECT team_id FROM team WHERE team_code=? LIMIT 1`,
        [team_code]
      );

      if (teamRows.length) {
        team_id = teamRows[0].team_id;

        const [carRows] = await pool.query(
          `SELECT car_id FROM car WHERE team_id=? LIMIT 1`,
          [team_id]
        );
        if (carRows.length) car_id = carRows[0].car_id;
      }
    }

    await pool.query(
      `
      INSERT INTO Run
        (run_id, maze_id, algorithm_id, run_time, path_length, goal_reached, nodes_explored, date, team_id, car_id, notes)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        run_id,
        maze_id,
        algorithm_id,
        Number(run_time),
        path_length == null ? 0 : Number(path_length),
        goal_reached == null ? false : Boolean(goal_reached),
        nodes_explored == null ? 0 : Number(nodes_explored),
        date ?? new Date().toISOString().slice(0, 10), // YYYY-MM-DD
        team_id,
        car_id,
        notes ?? null,
      ]
    );

    res.status(201).json({ ok: true, run_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
// LOGBOOK endpoints (DB-backed logbook)
// Requires columns in Logbook_Post:
// - author_name VARCHAR(120)
// - car_model  VARCHAR(120)
// =========================================================

// GET logbook posts (optional filter: ?team_code=T01)
app.get("/api/logbook", async (req, res) => {
  try {
    const { team_code } = req.query;

    if (team_code) {
      const [rows] = await pool.query(
        `
        SELECT
          p.post_id,
          p.title,
          p.body,
          p.created_at,
          p.run_id,
          p.author_name,
          p.car_model,
          t.team_code,
          t.team_name,
          t.contact_email
        FROM Logbook_Post p
        JOIN team t ON p.team_id = t.team_id
        WHERE t.team_code = ?
        ORDER BY p.created_at DESC
        LIMIT 200
        `,
        [team_code]
      );
      return res.json(rows);
    }

    const [rows] = await pool.query(
      `
      SELECT
        p.post_id,
        p.title,
        p.body,
        p.created_at,
        p.run_id,
        p.author_name,
        p.car_model,
        t.team_code,
        t.team_name,
        t.contact_email
      FROM Logbook_Post p
      JOIN team t ON p.team_id = t.team_id
      ORDER BY p.created_at DESC
      LIMIT 200
      `
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST logbook post
app.post("/api/logbook", async (req, res) => {
  try {
    const { team_code, title, body, run_id, author_name, car_model } = req.body;

    if (!team_code || !title || !body) {
      return res.status(400).json({ error: "Required: team_code, title, body" });
    }

    const [teamRows] = await pool.query(
      `SELECT team_id FROM team WHERE team_code=? LIMIT 1`,
      [team_code]
    );

    if (teamRows.length === 0) {
      return res.status(400).json({ error: `Team not found for team_code: ${team_code}` });
    }

    const team_id = teamRows[0].team_id;

    const [result] = await pool.query(
      `
      INSERT INTO Logbook_Post
        (team_id, user_id, run_id, title, body, author_name, car_model)
      VALUES
        (?, NULL, ?, ?, ?, ?, ?)
      `,
      [
        team_id,
        run_id || null,
        title,
        body,
        author_name || null,
        car_model || null,
      ]
    );

    res.status(201).json({ ok: true, post_id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
