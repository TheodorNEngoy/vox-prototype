import { ensureSchema } from "./_lib/db.js";

export default {
  async fetch() {
    await ensureSchema();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};
