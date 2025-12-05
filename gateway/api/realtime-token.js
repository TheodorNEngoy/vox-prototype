import { randomUUID } from "node:crypto";
import { requireProject, json } from "./_lib/gate.js";
import { consumeProjectMint, createSession, addEvent, isDbConfigured } from "./_lib/db.js";

async function readJson(request) {
  try {
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request) {
    const auth = await requireProject(request);
    if (auth instanceof Response) return auth;

    const { project } = auth;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return json({ error: "Missing OPENAI_API_KEY" }, 500);

    // Quota: minting client secrets costs money, so gate it here.
    const quota = await consumeProjectMint({
      project_id: project.id,
      daily_limit: project.daily_limit,
    });

    if (!quota.ok) {
      return json(
        {
          error: "Project daily limit exceeded",
          project_id: project.id,
          mints_today: quota.mints,
          daily_limit: quota.daily_limit,
        },
        429
      );
    }

    const body = request.method === "POST" ? await readJson(request) : {};
    const instructions =
      typeof body.instructions === "string" && body.instructions.trim()
        ? body.instructions.trim()
        : "You are Vox, a voice-first assistant. Be concise and helpful.";

    const session_id = randomUUID();
    const user_agent = request.headers.get("user-agent") || null;
    const ip = request.headers.get("x-forwarded-for") || null;

    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: "OpenAI client_secret mint failed", details: errText }, 500);
    }

    const data = await resp.json();
    const openai_session_id = data?.session?.id || null;

    if (isDbConfigured()) {
      try {
        await createSession({
          id: session_id,
          project_id: project.id,
          model: "gpt-realtime",
          openai_session_id,
          user_agent,
          ip,
          policy: { expires_after_seconds: 600 },
        });
        await addEvent({
          session_id,
          type: "token_issued",
          payload: { project_id: project.id, openai_session_id, expires_at: data.expires_at },
        });
      } catch (e) {
        console.error("DB logging failed:", e);
      }
    }

    return json({
      project_id: project.id,
      session_id,
      value: data.value,
      expires_at: data.expires_at,
      openai_session_id,
      db: isDbConfigured() ? "on" : "off",
      mints_today: quota.mints,
      daily_limit: quota.daily_limit,
    });
  },
};
