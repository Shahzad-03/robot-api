import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// Render uses DATABASE_URL for Postgres
if (!process.env.DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is not set. API will not connect to Postgres.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres often requires SSL; allow self-signed on managed services
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --------------------
// Health check
// --------------------
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --------------------
// Mazes
// --------------------
app.get("/api/mazes", async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM "Maze" ORDER BY maze_id`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Algorithms
// --------------------
app.get("/api/algorithms", async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM "Algorithm" ORDER BY algorithm_id`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Teams + members (nested)
// --------------------
app.get("/api/teams", async (req, res) => {
  try {
    const teamsR = await pool.query(`SELECT * FROM team ORDER BY team_code`);
    const membersR = await pool.query(`SELECT * FROM team_member ORDER BY team_id, member_id`);

    const membersByTeam = new Map();
    for (const m of membersR.rows) {
      const key = m.team_id;
      if (!membersByTeam.has(key)) membersByTeam.set(key, []);
      membersByTeam.get(key).push(m);
    }

    const result = teamsR.rows.map((t) => ({
      ...t,
      members: membersByTeam.get(t.team_id) || [],
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Runs (joined for UI display)
// --------------------
app.get("/api/runs", async (req, res) => {
  try {
    const r = await pool.query(`
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

      FROM "Run" r
      JOIN "Maze" m ON r.maze_id = m.maze_id
      JOIN "Algorithm" a ON r.algorithm_id = a.algorithm_id
      LEFT JOIN team t ON r.team_id = t.team_id
      LEFT JOIN car c ON r.car_id = c.car_id
      ORDER BY r.date DESC NULLS LAST, r.run_id DESC
      LIMIT 200
    `);

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST run (robot OR website form)
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
      team_code,
    } = req.body;

    if (!run_id || !maze_id || !algorithm_id || run_time == null) {
      return res.status(400).json({
        error: "Required: run_id, maze_id, algorithm_id, run_time",
      });
    }

    let team_id = null;
    let car_id = null;

    if (team_code) {
      const teamR = await pool.query(`SELECT team_id FROM team WHERE team_code=$1 LIMIT 1`, [
        team_code,
      ]);
      if (teamR.rows.length) {
        team_id = teamR.rows[0].team_id;

        const carR = await pool.query(`SELECT car_id FROM car WHERE team_id=$1 LIMIT 1`, [team_id]);
        if (carR.rows.length) car_id = carR.rows[0].car_id;
      }
    }

    await pool.query(
      `
      INSERT INTO "Run"
        (run_id, maze_id, algorithm_id, run_time, path_length, goal_reached, nodes_explored, date, team_id, car_id, notes)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        run_id,
        maze_id,
        algorithm_id,
        Number(run_time),
        path_length == null ? 0 : Number(path_length),
        goal_reached == null ? false : Boolean(goal_reached),
        nodes_explored == null ? 0 : Number(nodes_explored),
        date ?? new Date().toISOString().slice(0, 10),
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

// --------------------
// Logbook
// --------------------
// GET /api/logbook (optional: ?team_code=T01)
app.get("/api/logbook", async (req, res) => {
  try {
    const { team_code } = req.query;

    if (team_code) {
      const r = await pool.query(
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
        FROM "Logbook_Post" p
        JOIN team t ON p.team_id = t.team_id
        WHERE t.team_code = $1
        ORDER BY p.created_at DESC
        LIMIT 200
        `,
        [team_code]
      );
      return res.json(r.rows);
    }

    const r = await pool.query(
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
      FROM "Logbook_Post" p
      JOIN team t ON p.team_id = t.team_id
      ORDER BY p.created_at DESC
      LIMIT 200
      `
    );

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/logbook
app.post("/api/logbook", async (req, res) => {
  try {
    const { team_code, title, body, run_id, author_name, car_model } = req.body;

    if (!team_code || !title || !body) {
      return res.status(400).json({ error: "Required: team_code, title, body" });
    }

    const teamR = await pool.query(`SELECT team_id FROM team WHERE team_code=$1 LIMIT 1`, [
      team_code,
    ]);
    if (teamR.rows.length === 0) {
      return res.status(400).json({ error: `Team not found for team_code: ${team_code}` });
    }

    const team_id = teamR.rows[0].team_id;

    const insertR = await pool.query(
      `
      INSERT INTO "Logbook_Post"
        (team_id, user_id, run_id, title, body, author_name, car_model)
      VALUES
        ($1, NULL, $2, $3, $4, $5, $6)
      RETURNING post_id
      `,
      [team_id, run_id || null, title, body, author_name || null, car_model || null]
    );

    res.status(201).json({ ok: true, post_id: insertR.rows[0].post_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
