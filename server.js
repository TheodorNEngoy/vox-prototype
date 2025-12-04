require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

if (typeof fetch !== "function") {
  throw new Error("This server requires Node.js 18+ (global fetch).");
}

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const USERS_PATH = path.join(__dirname, "users.json");
const POSTS_PATH = path.join(__dirname, "posts.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(USERS_PATH)) fs.writeFileSync(USERS_PATH, "[]", "utf8");
if (!fs.existsSync(POSTS_PATH)) fs.writeFileSync(POSTS_PATH, "[]", "utf8");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function safeUsername(u) {
  return String(u || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 24);
}

app.use(express.json({ limit: "1mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "vox-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // secure: true, // enable when hosting behind HTTPS
    },
  })
);

app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "not_logged_in" });
  next();
}

// --- Auth APIs ---
app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });

  const users = readJson(USERS_PATH, []);
  const user = users.find((u) => u.id === req.session.userId);

  if (!user) {
    req.session.destroy(() => {});
    return res.json({ loggedIn: false });
  }

  res.json({ loggedIn: true, user: { id: user.id, username: user.username } });
});

app.post("/api/auth/register", (req, res) => {
  const username = safeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  if (username.length < 3) return res.status(400).json({ error: "username_too_short" });
  if (password.length < 6) return res.status(400).json({ error: "password_too_short" });

  const users = readJson(USERS_PATH, []);
  if (users.some((u) => u.username === username)) {
    return res.status(409).json({ error: "username_taken" });
  }

  const user = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: Date.now(),
  };

  users.push(user);
  writeJson(USERS_PATH, users);

  req.session.userId = user.id;
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

app.post("/api/auth/login", (req, res) => {
  const username = safeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  const users = readJson(USERS_PATH, []);
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(401).json({ error: "bad_credentials" });

  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "bad_credentials" });

  req.session.userId = user.id;
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- Upload + Posts ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const ext = path.extname(file.originalname || "").toLowerCase() || ".webm";
    const safeExt = [".webm", ".ogg", ".wav", ".mp3", ".m4a"].includes(ext) ? ext : ".webm";
    cb(null, `${id}${safeExt}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

app.get("/api/feed", (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "25", 10), 50));
  const today = String(req.query.today || "") === "1";

  const posts = readJson(POSTS_PATH, []);
  let filtered = posts;

  if (today) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = start + 24 * 60 * 60 * 1000;
    filtered = posts.filter((p) => p.createdAt >= start && p.createdAt < end);
  }

  filtered.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ posts: filtered.slice(0, limit) });
});

app.post("/api/posts", requireAuth, upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing "audio" file' });

  const users = readJson(USERS_PATH, []);
  const user = users.find((u) => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: "not_logged_in" });

  const posts = readJson(POSTS_PATH, []);
  const post = {
    id: req.file.filename,
    userId: user.id,
    username: user.username,
    title: (req.body?.title ? String(req.body.title) : "Voice post").slice(0, 140),
    url: `/uploads/${req.file.filename}`,
    createdAt: Date.now(),
  };

  posts.push(post);
  writeJson(POSTS_PATH, posts);

  res.json({ ok: true, post });
});

// --- OpenAI TTS (assistant voice) ---
const ALLOWED_VOICES = new Set([
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse",
]);

app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const voiceRaw = String(req.body?.voice || "verse").trim().toLowerCase();
  const voice = ALLOWED_VOICES.has(voiceRaw) ? voiceRaw : "verse";
  const format = String(req.body?.format || "mp3").trim().toLowerCase();
  const speed = Number(req.body?.speed ?? 1.05);

  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  if (!text) return res.status(400).json({ error: "Missing text" });
  if (text.length > 600) return res.status(400).json({ error: "Text too long for demo TTS" });

  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      format,
      speed,
      input: text,
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    return res.status(500).send(errText);
  }

  const buf = Buffer.from(await r.arrayBuffer());

  const contentType =
    format === "mp3" ? "audio/mpeg" :
    format === "opus" ? "audio/opus" :
    format === "aac" ? "audio/aac" :
    format === "wav" ? "audio/wav" :
    format === "flac" ? "audio/flac" :
    format === "pcm" ? "audio/pcm" :
    "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.send(buf);
});

app.listen(PORT, () => {
  console.log(`Vox running at http://localhost:${PORT}`);
});
