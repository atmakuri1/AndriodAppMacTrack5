// server/src/detection.ts
import { Router, Request, Response } from "express";
import { pool } from "./db";
import { authMiddleware, AuthRequest } from "./auth";

export const detectionRouter = Router();

/**
 * POST /detections/batch
 * Body: { detections: NewDetectionInput[] }
 * Inserts rows into the detections table.
 */
detectionRouter.post(
  "/detections/batch",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { detections } = req.body as { detections: any[] };

    if (!Array.isArray(detections) || detections.length === 0) {
      return res.status(400).json({ error: "detections must be a non-empty array" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const d of detections) {
        await client.query(
          `INSERT INTO detections (
              user_id,
              event_id,
              mac_address,
              signal_type,
              rssi,
              estimated_distance,
              latitude,
              longitude,
              detected_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            userId,
            d.event_id,
            d.mac_address,
            d.signal_type,
            d.rssi,
            d.estimated_distance,
            d.latitude,
            d.longitude,
            d.detected_at,
          ]
        );
      }

      await client.query("COMMIT");
      return res.json({ inserted: detections.length });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error inserting detections batch:", err);
      return res.status(500).json({ error: "Failed to insert detections batch" });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /detections
 * Optional query: ?event_id=...&mac_address=...&limit=100
 * Used for your "Detections" screen (possibly filtered to a single MAC).
 */
detectionRouter.get(
  "/events/:eventId/devices",
  authMiddleware,
  async (req, res) => {
    const { eventId } = req.params;

    try {
      const result = await pool.query(
        `
        SELECT
          mac_address,
          COUNT(*) AS detection_count,
          MIN(detected_at) AS first_seen,
          MAX(detected_at) AS last_seen
        FROM detections
        WHERE event_id = $1
        GROUP BY mac_address
        ORDER BY detection_count DESC, last_seen DESC;
        `,
        [eventId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Error in GET /events/:eventId/devices:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Detections for a single MAC in an event
detectionRouter.get(
  "/events/:eventId/devices/:mac/detections",
  authMiddleware,
  async (req, res) => {
    const { eventId, mac } = req.params;

    try {
      const result = await pool.query(
        `
        SELECT *
        FROM detections
        WHERE event_id = $1
          AND mac_address = $2
        ORDER BY detected_at DESC
        LIMIT 500;
        `,
        [eventId, mac]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Error in GET /events/:eventId/devices/:mac/detections:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export async function listDeviceMacSummaries(req: Request, res: Response) {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        mac_address,
        COUNT(*)::int AS detection_count,
        MIN(detected_at) AS first_seen,
        MAX(detected_at) AS last_seen
      FROM detections
      WHERE mac_address IS NOT NULL
      GROUP BY mac_address
      ORDER BY last_seen DESC
      `
    );
    res.json(rows);
  } catch (err) {
    console.error("listDeviceMacSummaries error:", err);
    res.status(500).json({ error: "Failed to load device MAC summaries" });
  }
}

// NEW: all detections for a single MAC
export async function listDetectionsForMac(req: Request, res: Response) {
  const mac = decodeURIComponent(req.params.mac);

  try {
    const { rows } = await pool.query(
      `
      SELECT
        blustick_id,
        event_id,
        mac_address,
        signal_type,
        rssi,
        estimated_distance,
        latitude,
        longitude,
        detected_at
      FROM detections
      WHERE mac_address = $1
      ORDER BY detected_at DESC
      `,
      [mac]
    );
    res.json(rows);
  } catch (err) {
    console.error("listDetectionsForMac error:", err);
    res.status(500).json({ error: "Failed to load detections for MAC" });
  }
}