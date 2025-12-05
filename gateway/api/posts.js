import { requireProject, json } from "./_lib/gate.js";
import { createPost, listPosts } from "./_lib/db.js";

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

    const url = new URL(request.url);

    if (request.method === "GET") {
      const limit = url.searchParams.get("limit") ?? "10";
      const posts = await listPosts({ project_id: project.id, limit });
      return json({ project_id: project.id, posts });
    }

    if (request.method === "POST") {
      const body = await readJson(request);
      const author = String(body.author || "").trim();
      const text = String(body.text || "").trim();

      if (!author) return json({ error: "Missing author" }, 400);
      if (!text) return json({ error: "Missing text" }, 400);
      if (text.length > 1000) return json({ error: "Text too long (max 1000 chars)" }, 400);

      const post = await createPost({ project_id: project.id, author, text });
      return json({ project_id: project.id, post }, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  },
};
