// styleSession.js

function nowMs() {
  return Date.now();
}

const TTL_MS = 5 * 60 * 1000;

function createStyleSessionStore() {
  const map = new Map();

  function set(userId, code) {
    map.set(String(userId), { code: String(code), expiresAt: nowMs() + TTL_MS });
  }

  // { state: "OK", code } | { state: "EXPIRED" } | { state: "NONE" }
  function getStatus(userId) {
    const key = String(userId);
    const session = map.get(key);
    if (!session) return { state: "NONE" };

    if (session.expiresAt < nowMs()) {
      map.delete(key);
      return { state: "EXPIRED" };
    }

    return { state: "OK", code: session.code };
  }

  function clear(userId) {
    map.delete(String(userId));
  }

  return { set, getStatus, clear, TTL_MS };
}

module.exports = { createStyleSessionStore, TTL_MS };
