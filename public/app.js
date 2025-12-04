// --- DOM ---
const authCard = document.getElementById("auth");
const appCard = document.getElementById("app");
const authMsg = document.getElementById("authMsg");
const who = document.getElementById("who");

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const loginUser = document.getElementById("loginUser");
const loginPass = document.getElementById("loginPass");
const regUser = document.getElementById("regUser");
const regPass = document.getElementById("regPass");

const logoutBtn = document.getElementById("logoutBtn");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const heardEl = document.getElementById("heard");
const player = document.getElementById("player");

// --- Helpers ---
function setStatus(s) { statusEl.textContent = `Status: ${s}`; }
function setHeard(t) { heardEl.textContent = t ? `Heard: "${t}"` : ""; }

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getMe() {
  const res = await fetch("/api/me");
  return res.json();
}

async function refreshUI() {
  const me = await getMe();
  if (!me.loggedIn) {
    authCard.hidden = false;
    appCard.hidden = true;
    return;
  }
  authCard.hidden = true;
  appCard.hidden = false;
  who.textContent = me.user.username;
}

// --- Auth ---
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authMsg.textContent = "";
  try {
    await postJSON("/api/auth/login", {
      username: loginUser.value,
      password: loginPass.value,
    });
    loginPass.value = "";
    await refreshUI();
  } catch (err) {
    authMsg.textContent = `Login failed: ${err.message}`;
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authMsg.textContent = "";
  try {
    await postJSON("/api/auth/register", {
      username: regUser.value,
      password: regPass.value,
    });
    regPass.value = "";
    await refreshUI();
  } catch (err) {
    authMsg.textContent = `Register failed: ${err.message}`;
  }
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
});

// --- Voice + Audio State ---
let voiceMode = false;
let recognition = null;
let recognitionWanted = false;
let ttsActive = false;

let micStream = null;

let recorder = null;
let recChunks = [];
let recordedBlob = null;

// If user says "Vox command send" while still recording, we stop then auto-send:
let actionAfterStop = null; // null | "send" | "cancel"

let queue = [];
let idx = -1;

const assistantAudio = new Audio();
assistantAudio.preload = "auto";

// ---- Tiny "ready" beep (optional but helps you know it's listening) ----
let beepCtx = null;
function beep() {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = beepCtx.createOscillator();
    const gain = beepCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.03;
    osc.connect(gain);
    gain.connect(beepCtx.destination);
    osc.start();
    setTimeout(() => {
      try { osc.stop(); } catch {}
      try { osc.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    }, 70);
  } catch {}
}

// ---- Normalization ----
function normalize(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
}

function parseWake(normalized) {
  // Wake word: Vox / Box / Fox (mishearing happens)
  const m = normalized.match(/^(vox|box|fox)\s+(.*)$/);
  return m ? m[2].replace(/\s+/g, " ").trim() : null;
}

function isCommandHeader(cmd) {
  // More forgiving: command/commands/commend/comment
  return /^(command|commands|commend|comment)\b/.test(cmd);
}

function stripCommandHeader(cmd) {
  return cmd.replace(/^(command|commands|commend|comment)\s+/, "");
}

// ---- Speech recognition (commands) ----
function SpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function stopRecognition() {
  recognitionWanted = false;
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
}

function startRecognition() {
  const Ctor = SpeechRecognitionCtor();
  if (!Ctor) {
    setStatus("SpeechRecognition not supported (use Chrome/Edge).");
    return;
  }
  if (recognitionWanted) return;
  recognitionWanted = true;

  if (!recognition) {
    recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    // Ask for a few alternatives; we'll pick the first that matches a command.
    recognition.maxAlternatives = 5;

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (!result || !result.isFinal) return;

      // Collect all alternatives (n-best)
      const candidates = [];
      for (let i = 0; i < result.length; i++) {
        const tx = (result[i]?.transcript || "").trim();
        if (tx) candidates.push(tx);
      }
      if (!candidates.length) return;

      // Show the first candidate that looks like a wake-word command
      for (const cand of candidates) {
        const n = normalize(cand);
        if (/^(vox|box|fox)\b/.test(n)) {
          setHeard(cand);
          break;
        }
      }

      // Try each alternative until one actually triggers an action
      for (const cand of candidates) {
        if (handleTranscript(cand)) break;
      }
    };

    recognition.onerror = (e) => {
      console.warn("SpeechRecognition error:", e);
    };

    recognition.onend = () => {
      if (voiceMode && recognitionWanted && !ttsActive) {
        try { recognition.start(); } catch {}
      }
    };
  }

  try { recognition.start(); } catch {}
}

// ---- TTS (OpenAI voice via your server) ----
async function speak(text) {
  ttsActive = true;
  stopRecognition(); // avoid recognizing our own assistant voice

  const finish = () => {
    ttsActive = false;
    if (voiceMode) {
      beep();
      startRecognition();
    }
  };

  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: "verse",
        format: "mp3",
        speed: 1.05,
      }),
    });

    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      await new Promise((resolve) => {
        const cleanup = () => {
          assistantAudio.onended = null;
          assistantAudio.onerror = null;
          try { URL.revokeObjectURL(url); } catch {}
          resolve();
        };

        assistantAudio.onended = cleanup;
        assistantAudio.onerror = cleanup;

        assistantAudio.pause();
        assistantAudio.currentTime = 0;
        assistantAudio.src = url;

        assistantAudio.play().catch(() => cleanup());
      });

      finish();
      return;
    }
  } catch (e) {
    console.warn("OpenAI TTS failed, falling back to browser TTS:", e);
  }

  // Fallback: browser TTS
  try {
    if ("speechSynthesis" in window) {
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = resolve;
        u.onerror = resolve;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      });
    }
  } catch {}

  finish();
}

// ---- Mic ----
async function initMic() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return micStream;
}

// ---- Media Session (AirPods/media keys) ----
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.setActionHandler("play", () => player.play());
  navigator.mediaSession.setActionHandler("pause", () => player.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => playNext());
  navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
}

// ---- Feed playback ----
async function loadNewestToday() {
  const res = await fetch("/api/feed?limit=25&today=1");
  const data = await res.json();
  queue = data.posts || [];
  idx = -1;
}

async function playFromQueue(i) {
  if (!queue.length) {
    setStatus("no posts today");
    await speak("No posts found for today.");
    return;
  }

  idx = Math.max(0, Math.min(i, queue.length - 1));
  const post = queue[idx];

  player.src = post.url;
  try {
    await player.play(); // requires Start Voice Mode click at least once
    setStatus(`playing ${idx + 1} of ${queue.length} — ${post.username}`);
  } catch (e) {
    console.warn("Play blocked:", e);
    setStatus("play blocked");
    await speak("Audio play was blocked. Click Start Voice Mode once, then try again.");
  }
}

function playNext() { if (queue.length) playFromQueue((idx + 1) % queue.length); }
function playPrev() { if (queue.length) playFromQueue((idx - 1 + queue.length) % queue.length); }

player.addEventListener("ended", () => {
  if (voiceMode) playNext();
});

async function playNewest() {
  setStatus("fetching newest");
  await speak("Fetching newest posts today.");
  await loadNewestToday();
  await playFromQueue(0);
}

// ---- Recording (NO auto-stop on silence) ----
function chooseMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

async function startRecording() {
  if (recorder?.state === "recording") { speak("Already recording."); return; }

  actionAfterStop = null;
  recordedBlob = null;
  recChunks = [];

  await initMic();

  // Tell user BEFORE recording starts, so assistant voice isn't recorded
  await speak("Recording. Start speaking now. When finished, say Vox command stop.");

  const stream = micStream;
  const mimeType = chooseMimeType();
  recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recChunks.push(e.data);
  };

  recorder.onstop = async () => {
    recordedBlob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
    recChunks = [];

    if (actionAfterStop === "cancel") {
      recordedBlob = null;
      actionAfterStop = null;
      setStatus("cancelled");
      await speak("Cancelled.");
      return;
    }

    if (actionAfterStop === "send") {
      actionAfterStop = null;
      await sendRecording(); // will speak once uploaded
      return;
    }

    setStatus("recorded (ready)");
    await speak("Recording stopped. Say Vox command send to post, or Vox command cancel.");
  };

  recorder.start(250);
  setStatus("recording");

  // Safety max length
  setTimeout(() => {
    if (recorder?.state === "recording") stopRecording();
  }, 60000);
}

function stopRecording() {
  if (!recorder || recorder.state !== "recording") return;
  try { recorder.stop(); } catch {}
}

async function cancelRecording() {
  if (recorder?.state === "recording") {
    actionAfterStop = "cancel";
    stopRecording();
    return;
  }
  recordedBlob = null;
  recChunks = [];
  setStatus("cancelled");
  await speak("Cancelled.");
}

async function sendRecording() {
  if (recorder?.state === "recording") {
    actionAfterStop = "send";
    stopRecording();
    return;
  }

  if (!recordedBlob) {
    await speak("Nothing recorded yet.");
    return;
  }

  setStatus("uploading");
  await speak("Uploading.");

  const fd = new FormData();
  fd.append("audio", recordedBlob, `post-${Date.now()}.webm`);
  fd.append("title", "New voice post");

  const res = await fetch("/api/posts", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus("upload failed");
    await speak(`Upload failed: ${data.error || "error"}`);
    return;
  }

  // Put your post in the queue immediately for demo
  queue.unshift(data.post);
  idx = 0;

  recordedBlob = null;
  setStatus("posted");
  await speak("Posted.");
}

// ---- Commands ----
// Returns true if it executed a command.
function handleTranscript(raw) {
  const n = normalize(raw);
  const cmd0 = parseWake(n);
  if (!cmd0) return false;

  const cmd = cmd0; // already normalized and squashed spaces
  const recording = recorder?.state === "recording";

  // Help can always run
  if (cmd.includes("help")) {
    speak("Commands: play newest posts today. next. previous. pause. resume. record. command stop. command send. command cancel.");
    return true;
  }

  // Identify "command ..." (more forgiving)
  const hasHeader = isCommandHeader(cmd);
  const cmdBody = hasHeader ? stripCommandHeader(cmd) : cmd;

  // While recording, ONLY accept command stop/send/cancel
  if (recording) {
    if (!hasHeader) return true; // we heard you, but ignore to avoid triggering on your post text
    if (/^(stop|end|done)\b/.test(cmdBody)) { stopRecording(); return true; }
    if (/^(send|sent|post|publish)\b/.test(cmdBody)) { sendRecording(); return true; }
    if (/^(cancel|discard)\b/.test(cmdBody)) { cancelRecording(); return true; }
    return true;
  }

  // Not recording: allow "command send/cancel" (THIS FIXES YOUR BUG)
  if (/^(send|sent|post|publish)\b/.test(cmdBody) || (hasHeader && /\bsend\b/.test(cmdBody))) {
    sendRecording();
    return true;
  }
  if (/^(cancel|discard)\b/.test(cmdBody)) {
    cancelRecording();
    return true;
  }

  // Normal playback/navigation commands
  if ((cmd.includes("play") || cmd.includes("start")) && (cmd.includes("newest") || cmd.includes("latest"))) {
    playNewest(); return true;
  }
  if ((cmd.includes("newest") || cmd.includes("latest")) && (cmd.includes("post") || cmd.includes("posts"))) {
    playNewest(); return true;
  }

  if (/^record\b/.test(cmd)) { startRecording(); return true; }

  if (/^next\b/.test(cmd)) { playNext(); return true; }
  if (/^(previous|back)\b/.test(cmd)) { playPrev(); return true; }

  if (/^pause\b/.test(cmd)) { player.pause(); speak("Paused."); return true; }
  if (/^(resume|play)\b/.test(cmd)) { player.play(); speak("Playing."); return true; }

  return true;
}

// --- Voice Mode buttons ---
startBtn.addEventListener("click", async () => {
  voiceMode = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  setupMediaSession();

  setStatus("requesting mic");
  await initMic();

  setStatus("voice mode on");
  await speak("Voice mode on. Say Vox help.");
  startRecognition();
});

stopBtn.addEventListener("click", async () => {
  voiceMode = false;
  stopRecognition();

  if (recorder?.state === "recording") {
    try { recorder.stop(); } catch {}
  }

  setStatus("voice mode off");
  startBtn.disabled = false;
  stopBtn.disabled = true;

  await speak("Voice mode off.");
});

// boot
refreshUI();
