import "./style.css";

const sessionsEl = document.querySelector("#sessions");
const replayEl = document.querySelector("#replay");
const statusEl = document.querySelector("#status");
const refreshBtn = document.querySelector("#refreshBtn");

function setStatus(s) {
  statusEl.textContent = s;
}

function fmt(d) {
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

async function loadSessions() {
  setStatus("Loading sessions…");
  const r = await fetch("/api/sessions?limit=50");
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);

  sessionsEl.innerHTML = "";
  for (const s of data.sessions) {
    const btn = document.createElement("button");
    btn.textContent = `${fmt(s.created_at)} — ${s.id.slice(0, 8)}… (${s.model})`;
    btn.style.display = "block";
    btn.style.margin = "8px 0";
    btn.addEventListener("click", () => loadReplay(s.id));
    sessionsEl.appendChild(btn);
  }

  setStatus("Loaded");
}

async function loadReplay(sessionId) {
  setStatus("Loading replay…");
  const r = await fetch(`/api/session?session_id=${encodeURIComponent(sessionId)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);

  const { session, events } = data;

  let out = "";
  out += `SESSION ${session.id}\n`;
  out += `created_at: ${fmt(session.created_at)}\n`;
  out += `model: ${session.model}\n`;
  out += `user_agent: ${session.user_agent ?? ""}\n`;
  out += "\nEVENTS\n";
  for (const e of events) {
    out += `• ${fmt(e.created_at)}  ${e.type}\n`;
    if (e.payload) out += `  ${JSON.stringify(e.payload)}\n`;
  }

  replayEl.textContent = out;
  setStatus("Loaded replay");
}

refreshBtn.addEventListener("click", () => {
  loadSessions().catch((e) => (setStatus(`Error: ${e.message}`)));
});

loadSessions().catch((e) => (setStatus(`Error: ${e.message}`)));
