import { isDbConfigured, getSession, listEvents } from "./_lib/db.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request) {
    try {
      if (request.method !== "GET") return json(405, { error: "Method not allowed" });

      if (!isDbConfigured()) {
        return json(503, {
          error: "DB not configured",
          hint: "Add Postgres to the Vercel project (POSTGRES_URL), run `vercel pull`, restart `vercel dev`.",
        });
      }

      const url = new URL(request.url);
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId) return json(400, { error: "Missing session_id" });

      const session = await getSession(sessionId);
      if (!session) return json(404, { error: "Not found" });

      const events = await listEvents(sessionId, 300);
      return json(200, { session, events });
    } catch (e) {
      return json(500, { error: "session crashed", detail: String(e?.message || e) });
    }
  },
};
