import { randomUUID } from "node:crypto";
import { isDbConfigured, tryAddEvent, tryCreateSession } from "./_lib/db.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function getIP(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export default {
  async fetch(request) {
    try {
      if (request.method !== "POST" && request.method !== "GET") {
        return json(405, { error: "Method not allowed" });
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return json(500, { error: "Missing OPENAI_API_KEY" });

      let instructions = null;
      if (request.method === "POST") {
        try {
          const body = await request.json();
          if (typeof body?.instructions === "string") {
            instructions = body.instructions.slice(0, 4000);
          }
        } catch {
          // ignore invalid JSON
        }
      }

      const model = "gpt-realtime";
      const sessionId = randomUUID();
      const userAgent = request.headers.get("user-agent");
      const ip = getIP(request);

      const policy = {
        model_allowlist: [model],
        expires_after_seconds: 600,
      };

      // Best-effort DB logging (won’t crash if POSTGRES_URL missing)
      await tryCreateSession({ id: sessionId, model, userAgent, ip, policy });
      await tryAddEvent({ sessionId, type: "session_created", payload: { model } });

      // Create ephemeral Realtime client secret (ek_...)
      const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 600 },
          session: {
            type: "realtime",
            model,
            ...(instructions ? { instructions } : {}),
          },
        }),
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        await tryAddEvent({ sessionId, type: "token_error", payload: data });
        return json(r.status, data);
      }

      await tryAddEvent({
        sessionId,
        type: "token_issued",
        payload: { expires_at: data.expires_at, openai_session_id: data?.session?.id ?? null },
      });

      return json(200, {
        session_id: sessionId,
        value: data.value,
        expires_at: data.expires_at,
        openai_session_id: data?.session?.id ?? null,
        db: isDbConfigured() ? "on" : "off",
      });
    } catch (e) {
      return json(500, { error: "realtime-token crashed", detail: String(e?.message || e) });
    }
  },
};
