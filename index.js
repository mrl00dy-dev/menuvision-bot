// index.js

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf } = require("telegraf");
const sharp = require("sharp");


const { createSheetsCache } = require("./sheetsCache");
const { createStyleSessionStore } = require("./styleSession");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// خله الافتراضي gpt-image-1 (عشان chatgpt-image-latest يطلع توثيق عندك)
// وتقدر تغيّره من .env لو عندك صلاحية
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-image-1.5";

const IMAGE_SIZE = process.env.IMAGE_SIZE || "1024x1024";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");

const bot = new Telegraf(BOT_TOKEN);

// =========================
// Messages (edit freely)
// =========================
const MSG = {
  INTRO:
    "Welcome.\n\n1) Send the style number (example: 101)\n2) Then send the food image\n\nIf you send an image without a style number, I will ask you for the style number first.",
  SALAM_REPLY: "وعليكم السلام ورحمة الله وبركاته",
  PROMPT_STYLE: "Send the style number to continue.",

  INVALID_STYLE: "Invalid style number. Send the style number again.",
  ASK_IMAGE: "Send the image.",
  NEED_STYLE_FIRST: "Send the style number first.",
  EXPIRED: "Session expired. Send the style number again.",

  PROCESSING: "Processing...",
  DONE: "Done.",
  FAILED: "Failed. Try again.",
};

// =========================
// Persistent store (users + anything else later)
// =========================
const STORE_FILE = path.join(__dirname, "sessions.json");

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return { users: {} };
    const obj = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!obj.users) obj.users = {};
    return obj;
  } catch {
    return { users: {} };
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

let store = loadStore();

function isFirstTimeUser(userId) {
  const id = String(userId);
  return !store.users?.[id];
}
function markUserSeen(userId) {
  const id = String(userId);
  if (!store.users) store.users = {};
  if (!store.users[id]) {
    store.users[id] = { firstSeenAt: Date.now() };
    saveStore(store);
  }
}

// =========================
// Google Sheets cache
// =========================
const stylesCache = createSheetsCache({ refreshEveryMs: 120000 }); // 2 minutes
stylesCache.ensureWarm().catch(console.error);
stylesCache.startAutoRefresh();

// =========================
// Per-user session (5 min TTL)
// =========================
const styleSessions = createStyleSessionStore();

// =========================
// Helpers
// =========================
function normalizeText(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function isNumericCode(text) {
  return /^\d+$/.test(normalizeText(text));
}

function isGreeting(text) {
  const t = normalizeText(text);
  if (t === "السلام") return true;
  const re = /^السلام\s+عليكم(?:\s+ورحمة\s+الله(?:\s+وبركاته)?)?[!.،]*$/;
  return re.test(t);
}

async function sendIntro(ctx) {
  await ctx.reply(MSG.INTRO);
}

async function sendPromptStyle(ctx) {
  await ctx.reply(MSG.PROMPT_STYLE);
}

// =========================
// Image helpers
// =========================
function sniffImageMime(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  return { mime: "image/jpeg", ext: "jpg" };
}

async function downloadTelegramPhoto(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const resp = await axios.get(link.href, { responseType: "arraybuffer" });

  const buffer = Buffer.from(resp.data);
  const headerType = (resp.headers["content-type"] || "").toLowerCase();
  const sniffed = sniffImageMime(buffer);

  const mime =
    headerType.startsWith("image/") && headerType !== "application/octet-stream"
      ? headerType
      : sniffed.mime;

  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { buffer, contentType: mime, ext };
}


// =========================
// OpenAI edit
// =========================
async function openaiEditImage({ imageBuffer, mimeType, prompt }) {
  const form = new FormData();

  form.append("model", "dall-e-2");
  form.append("prompt", prompt);
  form.append("size", IMAGE_SIZE);
  form.append("response_format", "b64_json");

  // DALL·E edits supports PNG only → convert anything (jpeg/webp/...) to PNG
  const pngBuffer = await sharp(imageBuffer).png().toBuffer();

  form.append("image", pngBuffer, {
    filename: "input.png",
    contentType: "image/png",
  });

  const resp = await axios.post("https://api.openai.com/v1/images/edits", form, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
    timeout: 180000,
    maxBodyLength: Infinity,
  });

  const b64 = resp?.data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI: no b64_json returned");
  return Buffer.from(b64, "base64");
}


// =========================
// Gemini (Nano Banana) edit
// =========================
async function geminiEditImage({ imageBuffer, mimeType, prompt }) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
    GEMINI_API_KEY;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageBuffer.toString("base64") } },
        ],
      },
    ],
  };

  const resp = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 180000,
  });

  const parts = resp?.data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
  const b64 = imgPart?.inlineData?.data;

  if (!b64) throw new Error("Gemini: no image returned");
  return Buffer.from(b64, "base64");
}

// =========================
// Bot flow
// =========================
bot.start(async (ctx) => {
  const first = isFirstTimeUser(ctx.from.id);
  markUserSeen(ctx.from.id);

  if (first) return sendIntro(ctx);
  return sendPromptStyle(ctx);
});

// TEXT handler
bot.on("text", async (ctx) => {
  const text = normalizeText(ctx.message?.text || "");
  const first = isFirstTimeUser(ctx.from.id);

  markUserSeen(ctx.from.id);

  if (isGreeting(text)) {
    await ctx.reply(MSG.SALAM_REPLY);
    if (first) return sendIntro(ctx);
    return sendPromptStyle(ctx);
  }

  if (isNumericCode(text)) {
    let prompt = stylesCache.getPrompt(text);
    if (!prompt) {
      await stylesCache.refresh().catch(() => {});
      prompt = stylesCache.getPrompt(text);
    }

    if (!prompt) return ctx.reply(MSG.INVALID_STYLE);

    styleSessions.set(ctx.from.id, text);
    return ctx.reply(MSG.ASK_IMAGE);
  }

  if (first) return sendIntro(ctx);
  return sendPromptStyle(ctx);
});

// PHOTO handler
bot.on("photo", async (ctx) => {
  const status = styleSessions.getStatus(ctx.from.id);

  markUserSeen(ctx.from.id);

  if (status.state === "NONE") return ctx.reply(MSG.NEED_STYLE_FIRST);
  if (status.state === "EXPIRED") return ctx.reply(MSG.EXPIRED);

  const code = status.code;

  // ensure prompt exists
  let prompt = stylesCache.getPrompt(code);
  if (!prompt) {
    await stylesCache.refresh().catch(() => {});
    prompt = stylesCache.getPrompt(code);
  }
  if (!prompt) {
    styleSessions.clear(ctx.from.id);
    return ctx.reply(MSG.INVALID_STYLE);
  }

  // model from sheet column C via stylesCache.getModel(code)
  // expected values: "openai" or "gemini"
  let model = "openai";
  if (typeof stylesCache.getModel === "function") {
    const m = stylesCache.getModel(code);
    if (m) model = String(m).trim().toLowerCase();
  }

  const photos = ctx.message.photo || [];
  const best = photos[photos.length - 1];
  const fileId = best?.file_id;

  await ctx.reply(MSG.PROCESSING);
  await ctx.telegram.sendChatAction(ctx.chat.id, "upload_photo");

  try {
    const { buffer, contentType } = await downloadTelegramPhoto(ctx, fileId);

    let outBuffer;
    if (model === "gemini") {
      outBuffer = await geminiEditImage({
        imageBuffer: buffer,
        mimeType: contentType,
        prompt,
      });
    } else {
      outBuffer = await openaiEditImage({
        imageBuffer: buffer,
        mimeType: contentType,
        prompt,
      });
    }

    await ctx.replyWithPhoto({ source: outBuffer }, { caption: MSG.DONE });
  } catch (err) {
    console.error(err);
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message || MSG.FAILED;
    await ctx.reply(String(msg).slice(0, 3500));
  } finally {
    styleSessions.clear(ctx.from.id);
  }
});

bot.catch((err) => console.error("Bot error:", err));

// =========================
// Webhook launch
// =========================
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!WEBHOOK_URL) throw new Error("Missing WEBHOOK_URL");

bot.launch({
  webhook: {
    domain: WEBHOOK_URL.replace(/\/$/, ""),
    hookPath: WEBHOOK_PATH,
    port: PORT,
  },
});

console.log("Bot is running (webhook)...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));