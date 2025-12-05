import { isDbConfigured, tryAddEvent } from "./_lib/db.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request) {
    try {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" });

      let body;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "Invalid JSON" });
      }

      const sessionId = body?.session_id;
      const type = body?.type;
      const payload = body?.payload ?? {};

      if (typeof sessionId !== "string" || sessionId.length < 8) return json(400, { error: "Bad session_id" });
      if (typeof type !== "string" || type.length < 2) return json(400, { error: "Bad type" });

      // If DB isn't configured, don't crash—just no-op.
      if (!isDbConfigured()) return json(200, { ok: false, db: "off" });

      const ok = await tryAddEvent({ sessionId, type, payload });
      return json(200, { ok, db: "on" });
    } catch (e) {
      return json(500, { error: "log-event crashed", detail: String(e?.message || e) });
    }
  },
};
