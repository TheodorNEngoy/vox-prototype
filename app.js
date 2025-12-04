require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();

// Vercel Functions: read-only filesystem, writable /tmp scratch space. :contentReference[oaicite:2]{index=2}
const IS_VERCEL = !!process.env.VERCEL;

// Put ALL writable data under /tmp on Vercel; keep normal files locally.
const DATA_ROOT = IS_VERCEL ? path.join(os.tmpdir(), "vox") : __dirname;

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(DATA_ROOT, "uploads");
const USERS_PATH = path.join(DATA_ROOT, "users.json");
const POSTS_PATH = path.join(DATA_ROOT, "posts.json");

// Ensure writable dirs/files exist (in /tmp on Vercel)
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

// Helpful for hosted environments (safe even if not strictly required here)
if (IS_VERCEL) app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "vox-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // secure: true, // enable later when you move to real auth + HTTPS cookie policy
    },
  })
);

// NOTE: On Vercel, express.static() is ignored — static assets must be in public/**. :contentReference[oaicite:3]{index=3}
// Keeping these helps local dev only.
app.use(express.static(PUBLIC_DIR));

// Serve uploads via a real route (NOT express.static) so it still works on Vercel.
// Still not "production durable" (files live in /tmp), but it stops crashing.
app.get("/uploads/:file", (req, res) => {
  const name = String(req.params.file || "");
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return res.status(400).end();

  const filePath = path.join(UPLOAD_DIR, name);
  if (!filePath.startsWith(UPLOAD_DIR)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();

  res.sendFile(filePath);
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "not_logged_in" });
  next();
}

// --- Auth ---
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

// --- Uploads + Posts ---
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

// --- OpenAI TTS ---
const ALLOWED_VOICES = new Set([
  "alloy","ash","ballad","coral","echo","fable","onyx","nova","sage","shimmer","verse",
]);

app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const voiceRaw = String(req.body?.voice || "verse").trim().toLowerCase();
  const voice = ALLOWED_VOICES.has(voiceRaw) ? voiceRaw : "verse";
  const format = String(req.body?.format || "mp3").trim().toLowerCase();
  const speed = Number(req.body?.speed ?? 1.05);

  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  if (!text) return res.status(400).json({ error: "Missing text" });

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

  if (!r.ok) return res.status(500).send(await r.text());

  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader("Content-Type", format === "mp3" ? "audio/mpeg" : "application/octet-stream");
  res.send(buf);
});

module.exports = app;
