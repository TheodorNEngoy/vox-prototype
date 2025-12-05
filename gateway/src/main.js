import "./style.css";
import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";

const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");
const promptEl = document.querySelector("#prompt");

promptEl.value = [
  "You are Vox, a voice-first assistant.",
  "Be concise and natural.",
  "If the user asks for 'newest posts', propose a short plan and ask one follow-up question.",
].join("\n");

let session = null;
let sessionId = null;

function log(line) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${line}\n` + logEl.textContent;
}

async function postEvent(type, payload = {}) {
  if (!sessionId) return;
  try {
    await fetch("/api/log-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, type, payload }),
    });
  } catch {
    // best-effort; logging should never break UX
  }
}

async function fetchEphemeralKey(instructions) {
  const r = await fetch("/api/realtime-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Token error (${r.status})`);
  if (!data?.value || !data?.session_id) throw new Error("Bad token response");
  return data;
}

async function disconnect() {
  try {
    if (!session) return;
    if (typeof session.disconnect === "function") await session.disconnect();
    else if (typeof session.close === "function") await session.close();
  } finally {
    session = null;
  }
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  statusEl.textContent = "Starting…";
  log("Requesting ephemeral key…");

  const t0 = performance.now();

  try {
    const token = await fetchEphemeralKey(promptEl.value || "");
    sessionId = token.session_id;

    log(`Got token. Session: ${sessionId.slice(0, 8)}…`);
    await postEvent("client_token_received", {
      ms: Math.round(performance.now() - t0),
      expires_at: token.expires_at,
    });

    const agent = new RealtimeAgent({
      name: "Vox",
      instructions: promptEl.value || "You are Vox, a helpful assistant.",
    });

    session = new RealtimeSession(agent, { model: "gpt-realtime" });

    const t1 = performance.now();
    log("Connecting voice session…");
    await postEvent("client_connect_start");

    // Agents SDK quickstart: connect with the ek_... token. :contentReference[oaicite:6]{index=6}
    await session.connect({ apiKey: token.value });

    const msConnect = Math.round(performance.now() - t1);
    statusEl.textContent = "Connected — talk now";
    stopBtn.disabled = false;
    log(`Connected (connect ms: ${msConnect})`);
    await postEvent("client_connected", { ms: msConnect });
  } catch (err) {
    log(`ERROR: ${err?.message || err}`);
    statusEl.textContent = "Error";
    await postEvent("client_error", { message: err?.message || String(err) });
    startBtn.disabled = false;
    await disconnect();
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  statusEl.textContent = "Stopping…";
  log("Disconnecting…");
  await postEvent("client_disconnect_click");
  await disconnect();
  await postEvent("client_disconnected");
  statusEl.textContent = "Idle";
  startBtn.disabled = false;
  log("Disconnected.");
});

window.addEventListener("beforeunload", () => {
  postEvent("client_unload").finally(() => disconnect());
});
