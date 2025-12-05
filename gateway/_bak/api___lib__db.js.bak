import { sql } from "@vercel/postgres";

export function isDbConfigured() {
  return Boolean(
    process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING
  );
}

let schemaPromise = null;

export async function ensureSchema() {
  if (!isDbConfigured()) {
    throw new Error("DB not configured (missing POSTGRES_URL env vars).");
  }

  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS vox_sessions (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          model TEXT NOT NULL,
          user_agent TEXT,
          ip TEXT,
          policy JSONB
        );
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS vox_events (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES vox_sessions(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          type TEXT NOT NULL,
          payload JSONB
        );
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS vox_events_session_created_idx
        ON vox_events (session_id, created_at);
      `;
    })().catch((e) => {
      schemaPromise = null; // allow retry after failures
      throw e;
    });
  }

  return schemaPromise;
}

// ✅ best-effort helpers (never throw)
export async function tryCreateSession({ id, model, userAgent, ip, policy }) {
  if (!isDbConfigured()) return false;
  try {
    await ensureSchema();
    await sql`
      INSERT INTO vox_sessions (id, model, user_agent, ip, policy)
      VALUES (
        ${id},
        ${model},
        ${userAgent ?? null},
        ${ip ?? null},
        ${JSON.stringify(policy ?? {})}::jsonb
      );
    `;
    return true;
  } catch (e) {
    console.error("tryCreateSession failed:", e);
    return false;
  }
}

export async function tryAddEvent({ sessionId, type, payload }) {
  if (!isDbConfigured()) return false;
  try {
    await ensureSchema();
    await sql`
      INSERT INTO vox_events (session_id, type, payload)
      VALUES (${sessionId}, ${type}, ${JSON.stringify(payload ?? {})}::jsonb);
    `;
    return true;
  } catch (e) {
    console.error("tryAddEvent failed:", e);
    return false;
  }
}

// Console endpoints still require DB (that’s fine)
export async function listSessions(limit = 50) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT id, created_at, model, user_agent, ip
    FROM vox_sessions
    ORDER BY created_at DESC
    LIMIT ${limit};
  `;
  return rows;
}

export async function getSession(sessionId) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT id, created_at, model, user_agent, ip, policy
    FROM vox_sessions
    WHERE id = ${sessionId}
    LIMIT 1;
  `;
  return rows[0] ?? null;
}

export async function listEvents(sessionId, limit = 300) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT id, created_at, type, payload
    FROM vox_events
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC
    LIMIT ${limit};
  `;
  return rows;
}
