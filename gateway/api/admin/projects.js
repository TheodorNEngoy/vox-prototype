import { requireAdminKey, json } from "../_lib/gate.js";
import { createProject, listProjects } from "../_lib/db.js";

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
    const denied = requireAdminKey(request);
    if (denied) return denied;

    if (request.method === "GET") {
      const projects = await listProjects(200);
      return json({ projects });
    }

    if (request.method === "POST") {
      const body = await readJson(request);
      const name = String(body.name || "").trim();
      const daily_limit = body.daily_limit;

      const { project, project_key } = await createProject({ name, daily_limit });
      return json({ project, project_key }, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  },
};
