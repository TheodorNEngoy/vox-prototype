import { isDbConfigured, listSessions } from "./_lib/db.js";

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
          hint: "Add a Postgres integration to the Vercel project (so POSTGRES_URL exists), then run `vercel pull` and restart `vercel dev`.",
        });
      }

      const url = new URL(request.url);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

      const sessions = await listSessions(limit);
      return json(200, { sessions });
    } catch (e) {
      return json(500, { error: "sessions crashed", detail: String(e?.message || e) });
    }
  },
};
