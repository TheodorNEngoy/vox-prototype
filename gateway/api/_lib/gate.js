import { hashKey, getProjectByKeyHash } from "./db.js";

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function requireAdminKey(request) {
  const expected = process.env.VOX_ADMIN_KEY;
  if (!expected) return json({ error: "Missing VOX_ADMIN_KEY (set it in env vars)" }, 500);

  const got = request.headers.get("x-vox-admin-key");
  if (!got) return json({ error: "Missing x-vox-admin-key" }, 401);
  if (got !== expected) return json({ error: "Invalid x-vox-admin-key" }, 401);

  return null;
}

export async function requireProject(request) {
  const raw =
    request.headers.get("x-vox-project-key") ||
    request.headers.get("x-vox-demo-key"); // legacy alias

  if (!raw) return json({ error: "Missing project key (x-vox-project-key)" }, 401);

  const key_hash = hashKey(raw);
  const project = await getProjectByKeyHash(key_hash);

  if (!project) return json({ error: "Invalid project key" }, 401);
  if (project.active === false) return json({ error: "Project disabled" }, 403);

  return { project };
}
