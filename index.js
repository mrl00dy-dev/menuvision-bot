require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-image-1";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1024x1024";

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");

const bot = new Telegraf(BOT_TOKEN);

// ---- Simple file-based storage (so it survives restarts) ----
const STORE_FILE = path.join(__dirname, "sessions.json");

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}
function sessionKey(ctx, chatId, userId) {
  const c = chatId ?? ctx.chat?.id;
  const u = userId ?? ctx.from?.id;
  return `${c}_${u}`;
}

let store = loadStore();

// ---- Style prompts ----
const PROMPTS = {
  STYLE_A1: `
Using the provided image as the main reference, create a clean, premium commercial food photo.
Single hero dish, minimal background, crisp lighting, ultra-realistic.
Keep the dish identity consistent with the original image. Do not change ingredients.
`.trim(),
  STYLE_L1: `
Using the provided image as the main reference, create an editorial lifestyle food photo.
Natural window light, warm tones, casual table styling, authentic feel.
Keep the dish identity consistent with the original image. Do not change ingredients.
`.trim(),
  STYLE_C1: `
Using the provided image as the main reference, create a cinematic, moody food photo.
Dramatic shadows, high contrast, premium look, ultra-realistic textures.
Keep the dish identity consistent with the original image. Do not change ingredients.
`.trim(),
};

function styleKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("A1", "STYLE_A1"),
      Markup.button.callback("L1", "STYLE_L1"),
    ],
    [Markup.button.callback("C1", "STYLE_C1")],
  ]);
}

// ---- Helpers ----
function sniffImageMime(buffer) {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
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

  // JPEG signature: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // WEBP signature: "RIFF"...."WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  // fallback
  return { mime: "image/jpeg", ext: "jpg" };
}

async function downloadTelegramPhoto(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const resp = await axios.get(link.href, { responseType: "arraybuffer" });

  const buffer = Buffer.from(resp.data);
  const headerType = (resp.headers["content-type"] || "").toLowerCase();

  const sniffed = sniffImageMime(buffer);

  // Telegram sometimes returns application/octet-stream; use sniffed type then
  const mime =
    headerType.startsWith("image/") && headerType !== "application/octet-stream"
      ? headerType
      : sniffed.mime;

  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

  return { buffer, contentType: mime, ext };
}

async function openaiEditImage({ imageBuffer, mimeType, prompt }) {
  const form = new FormData();
  form.append("model", OPENAI_MODEL);
  form.append("prompt", prompt);
  form.append("size", IMAGE_SIZE);

  // Attach image as file (must be jpeg/png/webp)
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  form.append("image", imageBuffer, {
    filename: `input.${ext}`,
    contentType: mimeType,
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

// ---- Bot flow ----
bot.start(async (ctx) => {
  await ctx.reply("Send a food photo, then choose A1 / L1 / C1.");
});

bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo;
  const best = photos[photos.length - 1];
  const fileId = best.file_id;

  const key = sessionKey(ctx);
  store[key] = { file_id: fileId, ts: Date.now() };
  saveStore(store);

  await ctx.reply("Photo received. Choose a style code:", styleKeyboard());
});

bot.action(["STYLE_A1", "STYLE_L1", "STYLE_C1"], async (ctx) => {
  const style = ctx.callbackQuery.data;
  const prompt = PROMPTS[style];
  const key = sessionKey(ctx, ctx.callbackQuery.message.chat.id, ctx.callbackQuery.from.id);

  const saved = store[key];
  if (!saved?.file_id) {
    await ctx.answerCbQuery("Send a photo first.");
    await ctx.reply("Please send a photo first, then choose a style.");
    return;
  }

  await ctx.answerCbQuery("Generating...");

  try {
    const { buffer, contentType } = await downloadTelegramPhoto(ctx, saved.file_id);

    const outBuffer = await openaiEditImage({
      imageBuffer: buffer,
      mimeType: contentType,
      prompt,
    });

    await ctx.replyWithPhoto({ source: outBuffer }, { caption: `Done (${style})` });
  } catch (err) {
    const msg = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err?.message || "Unknown error";
    await ctx.reply(`Failed: ${msg}`.slice(0, 3500));
  }
});

bot.catch((err) => console.error("Bot error:", err));

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com

if (!WEBHOOK_URL) throw new Error("Missing WEBHOOK_URL");

bot.launch({
  webhook: {
    domain: WEBHOOK_URL.replace(/\/$/, ""),
    hookPath: WEBHOOK_PATH,
    port: PORT,
  },
});

console.log("Bot is running (webhook)...");


// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
