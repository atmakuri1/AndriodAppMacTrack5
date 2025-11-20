import { Pool } from "pg";

// DATABASE_URL should be standard Postgres URL.
// In Cloud Run we will use the socket host via query param (see deploy step).
const connectionString = process.env.DATABASE_URL!;
export const pool = new Pool({ connectionString });
