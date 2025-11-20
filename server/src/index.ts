import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { pool } from "./db";

import { detectionRouter } from "./detection";
// ...other imports (auth, events, etc.)
import {
  // …your existing exports,
  listDeviceMacSummaries,
  listDetectionsForMac,
} from "./detection";



const app = express();
app.use(cors());
app.use(express.json());
app.use(detectionRouter);


const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// ========= Helpers =========
function getTokenFromReq(req: any) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}
function requireJwt(
  req: any,
  res: any
): { ok: true; payload: any } | { ok: false } {
  const token = getTokenFromReq(req);
  if (!token) {
    res.status(401).json({ error: "Missing token" });
    return { ok: false };
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    return { ok: true, payload };
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return { ok: false };
  }
}

function authMiddleware(req: any, res: any, next: any) {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;          // requireJwt already sent 401 response
  (req as any).user = auth.payload; // optional: attach payload for later
  next();
}


// ========= Auth (profiles) =========
const TABLE = "profiles";
const COL_ID = "user_id";
const COL_USERNAME = "username";
const COL_PASSWORD_HASH = "password_hash";

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

app.get("/", (_req, res) => res.json({ ok: true, service: "blustick-api" }));

// TEMPORARY: plaintext compare because your DB stores 1111/2222/etc.
app.post("/auth/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { username, password } = parsed.data;

  try {
    const q = `
      SELECT ${COL_ID} AS id, ${COL_USERNAME} AS username, ${COL_PASSWORD_HASH} AS password_hash
      FROM ${TABLE}
      WHERE ${COL_USERNAME} = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (String(user.password_hash) !== String(password)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { sub: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/me", async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    res.json({ userId: payload.sub, username: payload.username });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// ========= EVENTS =========
// Device MAC summaries (unique MACs + counts)
app.get("/device-macs", authMiddleware, listDeviceMacSummaries);

// Detections for a single MAC
app.get("/devices/:mac/detections", authMiddleware, listDetectionsForMac);

// GET /events?limit=100
app.get("/events", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;

  const limit = Math.min(
    parseInt(String(req.query.limit ?? "100"), 10) || 100,
    500
  );
  const q = `
    SELECT id, user_id, event_name, event_description, created_at
    FROM events
    ORDER BY created_at DESC
    LIMIT $1
  `;
  const { rows } = await pool.query(q, [limit]);
  res.json(rows);
});

// ========= DETECTIONS =========
// GET /detections?event_id=<uuid>&limit=200
// Returns newest first; filters by event if provided.
app.get("/detections", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;

  const limit = Math.min(
    parseInt(String(req.query.limit ?? "200"), 10) || 200,
    1000
  );
  const eventId = (req.query.event_id as string | undefined) || undefined;

  let sql = `
    SELECT blustick_id, event_id, mac_address, signal_type, rssi,
           estimated_distance, latitude, longitude, detected_at
    FROM detections
  `;
  const params: any[] = [];
  if (eventId) {
    sql += ` WHERE event_id = $1`;
    params.push(eventId);
  }
  sql += ` ORDER BY detected_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// POST /detections  -> bulk insert from app/ESP32
const NewDetectionSchema = z.object({
  event_id: z.string().uuid().nullable().optional(),
  mac_address: z.string().nullable(),
  signal_type: z.string().nullable().optional(),
  rssi: z.number().nullable().optional(),
  estimated_distance: z.number().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  detected_at: z.string().optional(), // ISO timestamp
});

app.post("/detections", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;

  try {
    const body = Array.isArray(req.body) ? req.body : [];
    if (!body.length) {
      return res.status(400).json({ error: "Body must be a non-empty array" });
    }

    const parsed: any[] = [];
    for (const row of body) {
      const r = NewDetectionSchema.safeParse(row);
      if (!r.success) {
        return res.status(400).json({ error: "Invalid detection payload" });
      }
      parsed.push(r.data);
    }

    const values: any[] = [];
    const rowsSql: string[] = [];

    parsed.forEach((d, i) => {
      const idx = i * 8;
      rowsSql.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8})`
      );
      values.push(
        d.event_id ?? null,
        d.mac_address ?? null,
        d.signal_type ?? null,
        d.rssi ?? null,
        d.estimated_distance ?? null,
        d.latitude ?? null,
        d.longitude ?? null,
        d.detected_at ? new Date(d.detected_at) : new Date()
      );
    });

    const sql = `
      INSERT INTO detections (
        event_id,
        mac_address,
        signal_type,
        rssi,
        estimated_distance,
        latitude,
        longitude,
        detected_at
      )
      VALUES ${rowsSql.join(",")}
    `;

    const result = await pool.query(sql, values);
    res.json({ inserted: result.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to insert detections" });
  }
});

// ========= DEVICES (MAP POSITIONS) =========
// GET /devices  -> latest device positions ordered by last_seen DESC
app.get("/devices", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;

  const q = `
    SELECT device_id, lat, lon, last_seen, sensor_id
    FROM devices
    ORDER BY last_seen DESC
  `;
  const { rows } = await pool.query(q);
  res.json(rows);
});

// ========= OBSERVATIONS =========
const ObservationSchema = z.object({
  full_name: z.string().min(1),
  observation_details: z.string().min(1),
});

app.get("/observations", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;

  const limit = Math.min(
    parseInt(String(req.query.limit ?? "100"), 10) || 100,
    500
  );
  const q = `
    SELECT id, user_id, full_name, observation_details, created_at
    FROM observations
    ORDER BY created_at DESC
    LIMIT $1
  `;
  const { rows } = await pool.query(q, [limit]);
  res.json(rows);
});

app.post("/observations", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;
  try {
    const parsed = ObservationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid observation payload" });
    }
    const { full_name, observation_details } = parsed.data;
    const q = `
      INSERT INTO observations (full_name, observation_details)
      VALUES ($1, $2)
      RETURNING id, user_id, full_name, observation_details, created_at
    `;
    const { rows } = await pool.query(q, [full_name, observation_details]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create observation" });
  }
});

// ========= QUESTIONNAIRE =========
const QuestionnaireSchema = z.object({
  respondent: z.string().min(1),
  q1: z.string().min(1),
  q2: z.string().min(1),
  q3: z.string().min(1),
  q4: z.string().min(1),
  q5: z.string().min(1),
});

app.get("/questionnaire-responses", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;

  const limit = Math.min(
    parseInt(String(req.query.limit ?? "100"), 10) || 100,
    500
  );
  const q = `
    SELECT id, event_id, respondent, q1, q2, q3, q4, q5, ts
    FROM questionnaire_responses
    ORDER BY ts DESC
    LIMIT $1
  `;
  const { rows } = await pool.query(q, [limit]);
  res.json(rows);
});

app.post("/questionnaire-responses", async (req, res) => {
  const auth = requireJwt(req, res);
  if (!auth.ok) return;

  try {
    const parsed = QuestionnaireSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid questionnaire payload" });
    }
    const { respondent, q1, q2, q3, q4, q5 } = parsed.data;
    const q = `
      INSERT INTO questionnaire_responses (respondent, q1, q2, q3, q4, q5)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, event_id, respondent, q1, q2, q3, q4, q5, ts
    `;
    const { rows } = await pool.query(q, [
      respondent,
      q1,
      q2,
      q3,
      q4,
      q5,
    ]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create questionnaire response" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API on :${port}`));
