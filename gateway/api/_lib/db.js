import { sql } from "@vercel/postgres";
import { createHash, randomBytes } from "node:crypto";

export function isDbConfigured() {
  return Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL);
}

export function hashKey(raw) {
  return createHash("sha256").update(String(raw), "utf8").digest("hex");
}

export function generateProjectKey() {
  return `vox_pk_${randomBytes(24).toString("base64url")}`;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

let schemaPromise = null;

export async function ensureSchema() {
  if (!isDbConfigured()) {
    throw new Error("DB not configured (missing POSTGRES_URL / DATABASE_URL env vars).");
  }

  if (!schemaPromise) {
    schemaPromise = (async () => {
      // --- Projects (access keys + policy) ---
      await sql`
        CREATE TABLE IF NOT EXISTS vox_projects (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          active BOOLEAN NOT NULL DEFAULT true,
          daily_limit INT NOT NULL DEFAULT 250
        );
      `;
      await sql`CREATE INDEX IF NOT EXISTS vox_projects_active_idx ON vox_projects(active);`;

      await sql`
        CREATE TABLE IF NOT EXISTS vox_project_usage (
          project_id TEXT NOT NULL REFERENCES vox_projects(id) ON DELETE CASCADE,
          day DATE NOT NULL,
          mints INT NOT NULL DEFAULT 0,
          PRIMARY KEY (project_id, day)
        );
      `;

      // --- Sessions + events (VoiceOps) ---
      await sql`
        CREATE TABLE IF NOT EXISTS vox_sessions (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `;
      await sql`ALTER TABLE vox_sessions ADD COLUMN IF NOT EXISTS project_id TEXT;`;
      await sql`ALTER TABLE vox_sessions ADD COLUMN IF NOT EXISTS model TEXT;`;
      await sql`ALTER TABLE vox_sessions ADD COLUMN IF NOT EXISTS openai_session_id TEXT;`;
      await sql`ALTER TABLE vox_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;`;
      await sql`ALTER TABLE vox_sessions ADD COLUMN IF NOT EXISTS ip TEXT;`;
      await sql`ALTER TABLE vox_sessions ADD COLUMN IF NOT EXISTS policy JSONB;`;

      await sql`ALTER TABLE vox_sessions ALTER COLUMN model SET DEFAULT 'gpt-realtime';`;
      await sql`UPDATE vox_sessions SET model = COALESCE(model, 'gpt-realtime') WHERE model IS NULL;`;
      await sql`UPDATE vox_sessions SET policy = COALESCE(policy, '{}'::jsonb) WHERE policy IS NULL;`;
      await sql`UPDATE vox_sessions SET project_id = COALESCE(project_id, 'demo') WHERE project_id IS NULL;`;

      await sql`
        CREATE TABLE IF NOT EXISTS vox_events (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES vox_sessions(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          type TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb
        );
      `;
      await sql`CREATE INDEX IF NOT EXISTS vox_events_session_created_idx ON vox_events (session_id, created_at);`;

      // --- Posts (voice-only social demo) ---
      await sql`
        CREATE TABLE IF NOT EXISTS vox_posts (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          author TEXT NOT NULL,
          text TEXT NOT NULL
        );
      `;
      await sql`ALTER TABLE vox_posts ADD COLUMN IF NOT EXISTS project_id TEXT;`;
      await sql`UPDATE vox_posts SET project_id = COALESCE(project_id, 'demo') WHERE project_id IS NULL;`;
      await sql`ALTER TABLE vox_posts ALTER COLUMN project_id SET DEFAULT 'demo';`;
      await sql`CREATE INDEX IF NOT EXISTS vox_posts_project_created_idx ON vox_posts (project_id, created_at DESC);`;

      // --- Auto-provision the "demo" project if VOX_DEMO_KEY exists ---
      if (process.env.VOX_DEMO_KEY) {
        const demoHash = hashKey(process.env.VOX_DEMO_KEY);
        await sql`
          INSERT INTO vox_projects (id, name, key_hash, active, daily_limit)
          VALUES ('demo', 'demo', ${demoHash}, true, 5000)
          ON CONFLICT (id) DO UPDATE SET
            key_hash = EXCLUDED.key_hash,
            active = true;
        `;
      }
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }

  return schemaPromise;
}

// ---------- Projects ----------
export async function createProject({ name, daily_limit }) {
  await ensureSchema();

  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Missing project name");

  const id = `proj_${randomBytes(12).toString("base64url")}`;
  const project_key = generateProjectKey();
  const key_hash = hashKey(project_key);
  const limit = clampInt(daily_limit, 1, 100000, 250);

  const { rows } = await sql`
    INSERT INTO vox_projects (id, name, key_hash, active, daily_limit)
    VALUES (${id}, ${cleanName}, ${key_hash}, true, ${limit})
    RETURNING id, created_at, name, active, daily_limit;
  `;

  return { project: rows[0], project_key };
}

export async function listProjects(limit = 100) {
  await ensureSchema();
  const capped = clampInt(limit, 1, 500, 100);

  const { rows } = await sql`
    SELECT id, created_at, name, active, daily_limit
    FROM vox_projects
    ORDER BY created_at DESC
    LIMIT ${capped};
  `;
  return rows;
}

export async function getProjectByKeyHash(key_hash) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT id, created_at, name, active, daily_limit
    FROM vox_projects
    WHERE key_hash = ${key_hash}
    LIMIT 1;
  `;
  return rows[0] ?? null;
}

export async function consumeProjectMint({ project_id, daily_limit }) {
  await ensureSchema();

  const { rows } = await sql`
    INSERT INTO vox_project_usage (project_id, day, mints)
    VALUES (${project_id}, CURRENT_DATE, 1)
    ON CONFLICT (project_id, day) DO UPDATE
      SET mints = vox_project_usage.mints + 1
    RETURNING mints;
  `;

  const mints = Number(rows?.[0]?.mints ?? 0);
  const limit = Number(daily_limit ?? 0);

  // limit <= 0 means "unlimited"
  if (limit > 0 && mints > limit) {
    // Best-effort revert, then block.
    await sql`
      UPDATE vox_project_usage
      SET mints = GREATEST(mints - 1, 0)
      WHERE project_id = ${project_id} AND day = CURRENT_DATE;
    `;
    return { ok: false, mints, daily_limit: limit };
  }

  return { ok: true, mints, daily_limit: limit };
}

// ---------- Sessions + events ----------
export async function createSession({
  id,
  project_id,
  model = "gpt-realtime",
  openai_session_id = null,
  user_agent = null,
  ip = null,
  policy = {},
}) {
  await ensureSchema();
  const policyJson = JSON.stringify(policy ?? {});
  await sql`
    INSERT INTO vox_sessions (id, project_id, model, openai_session_id, user_agent, ip, policy)
    VALUES (${id}, ${project_id}, ${model}, ${openai_session_id}, ${user_agent}, ${ip}, ${policyJson}::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      project_id = EXCLUDED.project_id,
      model = EXCLUDED.model,
      openai_session_id = COALESCE(EXCLUDED.openai_session_id, vox_sessions.openai_session_id),
      user_agent = COALESCE(EXCLUDED.user_agent, vox_sessions.user_agent),
      ip = COALESCE(EXCLUDED.ip, vox_sessions.ip),
      policy = COALESCE(EXCLUDED.policy, vox_sessions.policy);
  `;
}

export async function addEvent({ session_id, type, payload }) {
  await ensureSchema();
  const payloadJson = JSON.stringify(payload ?? {});
  await sql`
    INSERT INTO vox_events (session_id, type, payload)
    VALUES (${session_id}, ${type}, ${payloadJson}::jsonb);
  `;
}

// ---------- Posts ----------
export async function listPosts({ project_id, limit = 10 }) {
  await ensureSchema();
  const capped = clampInt(limit, 1, 50, 10);
  const { rows } = await sql`
    SELECT id, created_at, author, text
    FROM vox_posts
    WHERE project_id = ${project_id}
    ORDER BY created_at DESC
    LIMIT ${capped};
  `;
  return rows;
}

export async function createPost({ project_id, author, text }) {
  await ensureSchema();
  const { rows } = await sql`
    INSERT INTO vox_posts (project_id, author, text)
    VALUES (${project_id}, ${author}, ${text})
    RETURNING id, created_at, author, text;
  `;
  return rows[0];
}
