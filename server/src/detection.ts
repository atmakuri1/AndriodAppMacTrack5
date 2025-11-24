// server/src/detection.ts
import { Router, Request, Response } from "express";
import { pool } from "./db";
import { authMiddleware, AuthRequest } from "./auth";

export const detectionRouter = Router();

// GET /detections
// Optional query: ?event_id=...&mac_address=...&limit=200
detectionRouter.get(
  "/detections",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { event_id, mac_address } = req.query;
      const limitRaw = (req.query.limit as string) ?? "200";
      const limit = Math.min(parseInt(limitRaw, 10) || 200, 1000);

      let sql = `
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
        WHERE 1=1
      `;

      const params: any[] = [];
      let idx = 1;

      if (event_id) {
        sql += ` AND event_id = $${idx++}`;
        params.push(event_id);
      }

      if (mac_address) {
        sql += ` AND mac_address = $${idx++}`;
        params.push(mac_address);
      }

      sql += ` ORDER BY detected_at DESC LIMIT $${idx}`;
      params.push(limit);

      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (err) {
      console.error("Error in GET /detections:", err);
      res.status(500).json({ error: "Failed to load detections" });
    }
  }
);


/**
 * POST /detections/batch
 * Body: { detections: NewDetectionInput[] }
 * Inserts rows into the detections table.
 */
// Replace the POST /detections/batch endpoint in detection.ts
// This version doesn't insert user_id

detectionRouter.post(
  "/detections/batch",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { detections } = req.body as { detections: any[] };

    console.log("[Backend] Batch upload request");
    console.log("[Backend] Detections count:", detections?.length);

    if (!Array.isArray(detections) || detections.length === 0) {
      console.error("[Backend] Invalid detections array");
      return res.status(400).json({ error: "detections must be a non-empty array" });
    }

    // Log first detection for debugging
    console.log("[Backend] First detection:", JSON.stringify(detections[0], null, 2));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let inserted = 0;
      const errors: string[] = [];

      for (let i = 0; i < detections.length; i++) {
        const d = detections[i];
        
        // Validate required fields
        if (!d.mac_address) {
          errors.push(`Detection ${i}: missing mac_address`);
          continue;
        }

        if (!d.detected_at) {
          errors.push(`Detection ${i}: missing detected_at`);
          continue;
        }

        // Validate timestamp format
        try {
          new Date(d.detected_at);
        } catch {
          errors.push(`Detection ${i}: invalid timestamp: ${d.detected_at}`);
          continue;
        }

        try {
          // ✅ Removed user_id from INSERT
          await client.query(
            `INSERT INTO detections (
                event_id,
                mac_address,
                signal_type,
                rssi,
                estimated_distance,
                latitude,
                longitude,
                detected_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              d.event_id || null,
              d.mac_address,
              d.signal_type || "BLE",
              d.rssi ?? null,
              d.estimated_distance ?? null,
              d.latitude ?? null,
              d.longitude ?? null,
              d.detected_at,
            ]
          );
          inserted++;
        } catch (rowError: any) {
          console.error(`[Backend] Error inserting detection ${i}:`, rowError);
          console.error(`[Backend] SQL Error code:`, rowError.code);
          console.error(`[Backend] SQL Error detail:`, rowError.detail);
          errors.push(`Detection ${i}: ${rowError.message}`);
        }
      }

      if (inserted === 0) {
        await client.query("ROLLBACK");
        console.error("[Backend] No detections inserted. Errors:", errors);
        return res.status(400).json({ 
          error: "Failed to insert any detections",
          details: errors.join("; ")
        });
      }

      await client.query("COMMIT");
      console.log(`[Backend] Successfully inserted ${inserted}/${detections.length} detections`);
      
      if (errors.length > 0) {
        console.warn("[Backend] Some detections failed:", errors);
      }

      return res.json({ 
        inserted, 
        skipped: errors.length, 
        errors: errors.length > 0 ? errors : undefined 
      });

    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error("[Backend] Transaction error:", err);
      console.error("[Backend] Error code:", err.code);
      console.error("[Backend] Error detail:", err.detail);
      
      return res.status(500).json({ 
        error: "Database error",
        details: err.message,
        code: err.code
      });
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