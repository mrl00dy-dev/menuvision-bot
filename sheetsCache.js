const { google } = require("googleapis");

const SHEET_NAME = "برمجة الصور";
const RANGE = `${SHEET_NAME}!A:B`;

function nowMs() {
  return Date.now();
}

function normalizeCode(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizePrompt(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

async function fetchStylesOnce() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: RANGE,
  });

  const rows = res.data.values || [];
  const map = new Map();

  for (const row of rows) {
    const code = normalizeCode(row?.[0]);
    const prompt = normalizePrompt(row?.[1]);

    if (!code || !prompt) continue; // ignore blanks
    map.set(code, prompt);
  }

  return map;
}

function createSheetsCache({ refreshEveryMs = 120000 } = {}) {
  let styles = new Map();
  let lastRefreshAt = 0;
  let refreshInFlight = null;

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const newMap = await fetchStylesOnce();
      styles = newMap;
      lastRefreshAt = nowMs();
      return styles;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  function getPrompt(code) {
    const key = normalizeCode(code);
    return styles.get(key) || null;
  }

  async function ensureWarm() {
    if (styles.size === 0) await refresh();
  }

  // periodic refresh
  function startAutoRefresh() {
    setInterval(() => {
      refresh().catch(() => {});
    }, refreshEveryMs);
  }

  return {
    refresh,
    ensureWarm,
    startAutoRefresh,
    getPrompt,
    get lastRefreshAt() {
      return lastRefreshAt;
    },
    get size() {
      return styles.size;
    },
  };
}

module.exports = { createSheetsCache };
