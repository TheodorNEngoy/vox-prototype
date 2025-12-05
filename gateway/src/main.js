import "./style.css";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="shell">
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <div class="h1">Vox Gateway <span class="badge">Project Keys + Voice Social</span></div>
          <div class="small">Start → allow mic → say “newest posts” or “create a post: …”</div>
        </div>
        <div id="status" class="badge">idle</div>
      </div>

      <div style="height:12px"></div>

      <div class="row">
        <input id="accessKey" placeholder="Access key (x-vox-project-key)" />
        <input id="username" placeholder="username (e.g. theodor)" />
        <button id="save">Save</button>
      </div>

      <div style="height:12px"></div>

      <div class="row">
        <button id="start">Start</button>
        <button id="stop" disabled>Stop</button>
        <button id="clear">Clear log</button>
      </div>

      <div style="height:12px"></div>
      <div id="log" class="log"></div>
    </div>
  </div>
`;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const logEl = $("log");

function setStatus(s) {
  statusEl.textContent = s;
}

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `[${ts}] ${line}\n` + logEl.textContent;
}

const STORAGE = {
  accessKey: "vox_access_key",
  username: "vox_username",
};

function getAccessKey() {
  return $("accessKey").value.trim() || localStorage.getItem(STORAGE.accessKey) || "";
}
function getUsername() {
  return $("username").value.trim() || localStorage.getItem(STORAGE.username) || "anon";
}

$("accessKey").value = localStorage.getItem(STORAGE.accessKey) || "";
$("username").value = localStorage.getItem(STORAGE.username) || "";

$("save").onclick = () => {
  const ak = $("accessKey").value.trim();
  const un = $("username").value.trim();
  if (ak) localStorage.setItem(STORAGE.accessKey, ak);
  if (un) localStorage.setItem(STORAGE.username, un);
  log("Saved settings.");
};

$("clear").onclick = () => (logEl.textContent = "");

async function api(path, { method = "GET", body } = {}) {
  const key = getAccessKey();
  if (!key) throw new Error("Missing access key. Paste your project key, click Save.");

  // Send both headers to remain compatible with older clients,
  // but the backend primarily expects x-vox-project-key.
  const headers = {
    "x-vox-project-key": key,
    "x-vox-demo-key": key,
  };

  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(path, { method, headers, body: payload });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${txt}`);
  }
  return res.json();
}

// ---- Tools (voice -> actions) ----
const get_newest_posts = tool({
  name: "get_newest_posts",
  description: "Fetch newest posts and return a short natural spoken summary.",
  parameters: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  async execute({ limit }) {
    const data = await api(`/api/posts?limit=${limit}`);
    const posts = data.posts || [];
    if (!posts.length) return "There are no posts yet.";

    const lines = posts.map((p) => `${p.author} said: ${p.text}`);
    return `Here are the newest posts. ${lines.join(" ")} `;
  },
});

const create_post = tool({
  name: "create_post",
  description: "Create a new post in the feed.",
  parameters: z.object({ text: z.string().min(1).max(1000) }),
  needsApproval: true,
  async execute({ text }) {
    const author = getUsername();
    const { post } = await api("/api/posts", { method: "POST", body: { author, text } });
    return `Posted. ${post.author} said: ${post.text}`;
  },
});

const agent = new RealtimeAgent({
  name: "Vox",
  instructions: `
You are Vox: a voice-only social companion.
You help the user listen to and create posts.
If the user asks for newest posts / what's new / read the feed, call get_newest_posts with limit 5.
If the user says they want to post, capture their words as text and call create_post.
Be concise and natural.
`.trim(),
  tools: [get_newest_posts, create_post],
});

let session = null;

async function start() {
  $("start").disabled = true;
  $("stop").disabled = false;

  setStatus("requesting token...");
  log("Requesting Realtime client secret...");

  const token = await api("/api/realtime-token", {
    method: "POST",
    body: { instructions: agent.instructions },
  });

  const { value, project_id, mints_today, daily_limit } = token;
  log(`Got client secret. project=${project_id} mints_today=${mints_today}/${daily_limit}`);

  setStatus("connecting...");
  log("Connecting (mic permission prompt expected)...");

  session = new RealtimeSession(agent, {
    model: "gpt-realtime",
    config: {
      turnDetection: {
        type: "semantic_vad",
        eagerness: "medium",
        createResponse: true,
        interruptResponse: true,
      },
    },
  });

  session.on("tool_approval_requested", (_ctx, _agent, request) => {
    const raw = request?.rawItem;
    const name = raw?.name || "unknown_tool";
    const args = raw?.arguments ? JSON.stringify(raw.arguments) : "";

    log(`Approval requested: ${name} ${args}`);
    const ok = confirm(`Allow tool call?\n\n${name}\n${args}`);
    if (ok) {
      log("Approved.");
      session.approve(request.approvalItem);
    } else {
      log("Rejected.");
      session.reject(request.rawItem);
    }
  });

  session.on("audio_interrupted", () => log("Audio interrupted (you spoke over)."));
  session.on("history_updated", () => setStatus("live"));

  await session.connect({ apiKey: value });

  setStatus("live");
  log("Connected. Say: “newest posts” or “create a post: …”");
}

function stop() {
  try {
    session?.close();
  } catch {
    // ignore
  }
  session = null;
  setStatus("idle");
  $("start").disabled = false;
  $("stop").disabled = true;
  log("Stopped.");
}

$("start").onclick = () =>
  start().catch((e) => {
    log(`ERROR: ${e.message || e}`);
    setStatus("error");
    $("start").disabled = false;
    $("stop").disabled = true;
  });

$("stop").onclick = stop;
