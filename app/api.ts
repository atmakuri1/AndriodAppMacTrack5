// blustick/app/api.ts
import * as SecureStore from "expo-secure-store";

// 👇 your Cloud Run backend URL
export const API_BASE = "https://blustick-api-787208993865.us-south1.run.app";

/* ============================= Types ============================= */

export type EventRow = {
  id: string;                 // uuid
  user_id: string;            // uuid
  event_name: string;
  event_description: string | null;
  created_at: string;         // ISO
};

export type NewDetectionInput = {
  event_id: string | null;
  mac_address: string;
  signal_type: "BLE"; // or just "BLE" if only BLE
  rssi: number | null;
  estimated_distance: number | null;
  latitude: number | null;
  longitude: number | null;
  detected_at: string; // ISO string
};


export type DetectionRow = {
  blustick_id: string | null;     // uuid
  event_id: string | null;        // uuid
  mac_address: string | null;
  signal_type: string | null;     // e.g. "BLE" | "WiFi"
  rssi: number | null;
  estimated_distance: number | null;
  latitude: number | null;
  longitude: number | null;
  detected_at: string;            // ISO
};

export type DeviceRow = {
  device_id: string;
  lat: number;
  lon: number;
  last_seen: string;              // ISO (timestamptz)
  sensor_id: string | null;
};

export type ObservationRow = {
  id: string;                     // uuid
  user_id: string | null;         // can be null for now
  full_name: string;
  observation_details: string;
  created_at: string;             // ISO
};

export async function createDetectionsBatch(
  rows: NewDetectionInput[]
): Promise<{ inserted: number }> {
  if (!rows.length) {
    console.log("[API] createDetectionsBatch called with 0 rows, skipping");
    return { inserted: 0 };
  }

  const res = await authedFetch(`/detections/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ detections: rows }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to upload detections");
  return data as { inserted: number };
}


/* ============================= Auth ============================= */

export async function login(username: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Login failed");
  await SecureStore.setItemAsync("token", data.token);
  return data as { token: string; user: { id: number | string; username: string } };
}

export async function authedFetch(path: string, init?: RequestInit) {
  const token = await SecureStore.getItemAsync("token");
  const headers = { ...(init?.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

// 👇 NEW: get current user info from /me
export async function getMe(): Promise<{ userId: number | string; username: string }> {
  const res = await authedFetch(`/me`);
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load user");
  // /me returns { userId, username }
  return data as { userId: number | string; username: string };
}

/* ============================= API: Reads ============================= */

export async function getEvents(limit = 100): Promise<EventRow[]> {
  const res = await authedFetch(`/events?limit=${limit}`);
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load events");
  return data as EventRow[];
}

export async function getDetections(params?: { event_id?: string; limit?: number }): Promise<DetectionRow[]> {
  const qs = new URLSearchParams();
  if (params?.event_id) qs.set("event_id", params.event_id);
  if (params?.limit) qs.set("limit", String(params.limit));
  const res = await authedFetch(`/detections${qs.toString() ? `?${qs}` : ""}`);
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load detections");
  return data as DetectionRow[];
}

export async function getDevices(): Promise<DeviceRow[]> {
  const res = await authedFetch(`/devices`);
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load devices");
  return data as DeviceRow[];
}

/* ============================= API: Observations ============================= */

export async function getObservations(limit = 100): Promise<ObservationRow[]> {
  const res = await authedFetch(`/observations?limit=${limit}`);
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load observations");
  return data as ObservationRow[];
}

export async function createObservation(
  full_name: string,
  observation_details: string
): Promise<ObservationRow> {
  const res = await authedFetch(`/observations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name, observation_details }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to create observation");
  return data as ObservationRow;
}

/* ============================= API: Questionnaire ============================= */

export type QuestionnaireResponseRow = {
  id: string;
  event_id: string | null;
  respondent: string | null;
  q1: string | null;
  q2: string | null;
  q3: string | null;
  q4: string | null;
  q5: string | null;
  ts: string; // ISO timestamp
};

export async function getQuestionnaireResponses(
  limit = 100
): Promise<QuestionnaireResponseRow[]> {
  const res = await authedFetch(`/questionnaire-responses?limit=${limit}`);
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load questionnaire responses");
  return data as QuestionnaireResponseRow[];
}

export async function createQuestionnaireResponse(input: {
  respondent: string;
  q1: string;
  q2: string;
  q3: string;
  q4: string;
  q5: string;
}): Promise<QuestionnaireResponseRow> {
  const res = await authedFetch(`/questionnaire-responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to submit questionnaire");
  return data as QuestionnaireResponseRow;
}

/* ============================= Utils ============================= */

// ... everything you already have above (EventRow, DetectionRow, etc.) ...

/* ============================= Utils ============================= */

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* ============================= Event devices & detections ============================= */

export type EventDeviceSummary = {
  mac_address: string;
  detection_count: number;
  first_seen: string;
  last_seen: string;
};

// GET /events/:eventId/devices
export async function getEventDevices(
  eventId: string
): Promise<EventDeviceSummary[]> {
  const res = await authedFetch(`/events/${eventId}/devices`);
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load event devices");
  return data as EventDeviceSummary[];
}

// GET /events/:eventId/devices/:mac/detections
export async function getEventDeviceDetections(
  eventId: string,
  mac: string
): Promise<DetectionRow[]> {
  const res = await authedFetch(
    `/events/${eventId}/devices/${encodeURIComponent(mac)}/detections`
  );
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load detections");
  return data as DetectionRow[];
}
