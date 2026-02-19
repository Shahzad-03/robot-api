import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

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
// Teams (ERD: team + members + cars)
// --------------------
// Returns:
// [
//   {
//     team_id, team_name, team_leader,
//     members: { team_id, team_leader, member1..member4, mobile_contact, email_contact } | null,
//     cars: [{ car_id, car_name, car_type, team_id }, ...]
//   }
// ]
app.get("/api/teams", async (req, res) => {
  try {
    const teamsR = await pool.query(`SELECT * FROM team ORDER BY team_id`);
    const membersR = await pool.query(`SELECT * FROM members`);
    const carsR = await pool.query(`SELECT * FROM car ORDER BY car_id`);

    const membersByTeam = new Map();
    for (const m of membersR.rows) {
      membersByTeam.set(m.team_id, m);
    }

    const carsByTeam = new Map();
    for (const c of carsR.rows) {
      const key = c.team_id;
      if (!carsByTeam.has(key)) carsByTeam.set(key, []);
      carsByTeam.get(key).push(c);
    }

    const result = teamsR.rows.map((t) => ({
      ...t,
      members: membersByTeam.get(t.team_id) || null,
      cars: carsByTeam.get(t.team_id) || [],
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Cars (ERD: car belongs to team)
// --------------------
app.get("/api/cars", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        c.car_id,
        c.team_id,
        c.car_name,
        c.car_type,
        t.team_name,
        t.team_leader
      FROM car c
      JOIN team t ON c.team_id = t.team_id
      ORDER BY c.car_id
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Runs (ERD: run belongs to car; car belongs to team; team has members)
// --------------------
// Optional filters:
//   /api/runs?team_id=T01
//   /api/runs?car_id=C01
app.get("/api/runs", async (req, res) => {
  try {
    const { team_id, car_id } = req.query;

    const where = [];
    const params = [];

    if (team_id) {
      params.push(team_id);
      where.push(`t.team_id = $${params.length}`);
    }
    if (car_id) {
      params.push(car_id);
      where.push(`c.car_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const r = await pool.query(
      `
      SELECT
        r.run_id,
        r.car_id,
        r.run_time,
        r.date_recorded,
        r.run_length,
        r.algo_type,
        r.notes,

        c.car_name,
        c.car_type,
        c.team_id,

        t.team_name,
        t.team_leader,

        m.mobile_contact,
        m.email_contact,
        m.team_leader AS members_team_leader,
        m.member1,
        m.member2,
        m.member3,
        m.member4

      FROM "run" r
      JOIN car c ON r.car_id = c.car_id
      JOIN team t ON c.team_id = t.team_id
      LEFT JOIN members m ON m.team_id = t.team_id
      ${whereSql}
      ORDER BY r.date_recorded DESC NULLS LAST, r.run_id DESC
      LIMIT 200
      `,
      params
    );

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST run (ERD-compliant)
// Required: run_id, car_id, run_time
// Optional: date_recorded, run_length, algo_type, notes
app.post("/api/runs", async (req, res) => {
  try {
    const { run_id, car_id, run_time, date_recorded, run_length, algo_type, notes } = req.body;

    if (!run_id || !car_id || run_time == null) {
      return res.status(400).json({
        error: "Required: run_id, car_id, run_time",
      });
    }

    // Ensure car exists
    const carR = await pool.query(`SELECT car_id FROM car WHERE car_id = $1 LIMIT 1`, [car_id]);
    if (carR.rows.length === 0) {
      return res.status(400).json({ error: `Car not found for car_id: ${car_id}` });
    }

    await pool.query(
      `
      INSERT INTO "run"
        (run_id, car_id, run_time, date_recorded, run_length, algo_type, notes)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        String(run_id).trim(),
        String(car_id).trim(),
        Number(run_time),
        date_recorded ? String(date_recorded).slice(0, 10) : new Date().toISOString().slice(0, 10),
        run_length == null || run_length === "" ? null : Number(run_length),
        algo_type == null || algo_type === "" ? null : String(algo_type),
        notes == null || notes === "" ? null : String(notes),
      ]
    );

    res.status(201).json({ ok: true, run_id });
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
