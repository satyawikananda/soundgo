// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 SoundGo contributors
//
// SoundCloud for MyGo Music: the listener's stream, likes, playlists, search,
// artist pages, charts, lyrics and audio, played from a personal account.
//
// Signing in opens SoundCloud's sign-in page in MyGo Music's built-in window
// and captures oauth_token + oauth_refresh_token automatically; pasting cookies
// in the plugin settings remains available as an optional fallback. The public
// catalog works without signing in.
//
// SoundCloud serves audio as HLS, which the app cannot decode directly. The
// plugin ships a lightweight Go HLS helper (bin/hls-helper) that unwraps fMP4
// AAC / MP3 / MPEG-TS segments onto 127.0.0.1 without re-encoding. Tracks whose
// only streams are Widevine/PlayReady encrypted cannot be played and are marked
// unavailable.
//
// Everything the app shows is English text passed through host.t, which answers
// the translation in locales/zh-CN.json when the listener reads Chinese.

const API = "https://api-v2.soundcloud.com";
const AUTH = "https://api-auth.soundcloud.com";
const SECURE = "https://secure.soundcloud.com";
const SITE = "https://soundcloud.com";
const MOBI = "https://m.soundcloud.com";
const LRCLIB = "https://lrclib.net";
const MOBI_CLIENT_ID_FALLBACK = "KKzJxmw11tYpCs6T24P4uUYhqmjalG6M";
const ANDROID_WEB_AUTH_APP_ID = "3152";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const BROWSER_UA =
  host.platform === "darwin"
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

const PAGE = 20;
const CLIENT_ID_TTL = 24 * 60 * 60 * 1000;
const TRACK_TTL = 5 * 60 * 1000;
const MEDIA_TTL = 30 * 60 * 1000;
const HISTORY_MAX = 50;
const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000;
const REFRESH_MIN_DELAY = 5 * 1000;
const REFRESH_MAX_DELAY = 6 * 60 * 60 * 1000;
const REFRESH_RETRY_BASE = 60 * 1000;
const REFRESH_RETRY_MAX = 10 * 60 * 1000;

const t = host.t;

// ---------------------------------------------------------------------------
// Small helpers

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function load(key, fallback) {
  const value = host.storage.get(key);
  return value === undefined || value === null ? fallback : value;
}

function save(key, value) {
  host.storage.set(key, value);
}

function token() {
  return host.storage.get("token") || "";
}

function refreshToken() {
  return host.storage.get("refreshToken") || "";
}

function hasSession() {
  return !!(token() || refreshToken());
}

function requireToken() {
  if (!hasSession()) throw fail("signIn", t("Sign in with your oauth_token first"));
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Pure-JS base64 encoder so state encoding works in runtimes without btoa.
function encodeBase64(input) {
  const bytes = [];
  const encoded = encodeURIComponent(String(input || ""));
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64_CHARS[(n >> 18) & 63];
    out += BASE64_CHARS[(n >> 12) & 63];
    out += hasB ? BASE64_CHARS[(n >> 6) & 63] : "=";
    out += hasC ? BASE64_CHARS[n & 63] : "=";
  }
  return out;
}

function randomBase64Url(length) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function randomDeviceId() {
  const part = () => String(100000 + Math.floor(Math.random() * 900000));
  return `${part()}-${part()}-${part()}-${part()}`;
}

// Pure-JS base64url decoder so JWT inspection works in runtimes without atob.
function decodeBase64Url(input) {
  let str = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
  const mod = str.length % 4;
  if (mod === 1) return "";
  if (mod > 0) str += "=".repeat(4 - mod);

  const bytes = [];
  for (let i = 0; i < str.length; i += 4) {
    const a = BASE64_CHARS.indexOf(str[i]);
    const b = BASE64_CHARS.indexOf(str[i + 1]);
    const c = str[i + 2] === "=" ? 0 : BASE64_CHARS.indexOf(str[i + 2]);
    const d = str[i + 3] === "=" ? 0 : BASE64_CHARS.indexOf(str[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return "";
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((n >> 16) & 255);
    if (str[i + 2] !== "=") bytes.push((n >> 8) & 255);
    if (str[i + 3] !== "=") bytes.push(n & 255);
  }

  let pct = "";
  for (let i = 0; i < bytes.length; i++) {
    pct += "%" + bytes[i].toString(16).padStart(2, "0");
  }
  try {
    return decodeURIComponent(pct);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

function decodeJwtPayload(raw) {
  const parts = String(raw || "").split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  const decoded = decodeBase64Url(parts[1]);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function jwtExpiryMs(raw) {
  const payload = decodeJwtPayload(raw);
  const exp = payload && Number(payload.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

function jwtClientId(raw) {
  const payload = decodeJwtPayload(raw);
  return payload && typeof payload.client_id === "string"
    ? payload.client_id.trim()
    : "";
}

function stripQuotes(value) {
  const trimmed = String(value || "").trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractCookieFromHeader(raw, name) {
  const value = String(raw || "").trim();
  if (!value || !value.includes("=")) return "";
  // Supports raw Cookie headers ("Cookie: a=1; b=2"), DevTools "Copy as cURL"
  // (bash/cmd), and "Copy as fetch" snippets without matching partial names.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|[;\\s'"\`^:])${escaped}=([^;\\r\\n'"\`^]+)`,
  );
  const match = value.match(pattern);
  return match ? stripQuotes(match[1]) : "";
}

// A pasted value can be the token itself, `oauth_token=...`, or a full Cookie
// header copied from the developer tools.
function readToken(raw) {
  let value = stripQuotes(raw);
  if (!value) return "";
  if (/^OAuth\s+/i.test(value)) value = value.replace(/^OAuth\s+/i, "").trim();
  const fromCookie = extractCookieFromHeader(value, "oauth_token");
  if (fromCookie) return fromCookie;
  return value;
}

function readRefreshToken(raw) {
  const value = stripQuotes(raw);
  if (!value) return "";
  const fromCookie = extractCookieFromHeader(value, "oauth_refresh_token");
  if (fromCookie) return fromCookie;
  return value;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || !item.id) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP

async function request(url, options = {}) {
  const headers = {
    "user-agent": UA,
    accept: "application/json",
    referer: SITE + "/",
    ...(options.headers || {}),
  };
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
    redirect: "follow",
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: response.status, data, text };
}

function apiUrl(path, clientId, query) {
  const url = path.startsWith("http") ? new URL(path) : new URL(API + path);
  url.searchParams.set("client_id", clientId);
  for (const key of Object.keys(query || {})) {
    const value = query[key];
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function api(path, options = {}) {
  const query = { ...(options.query || {}) };
  const useAuth = options.auth !== false;
  let forceClientId = false;
  let triedClientIdRefresh = false;
  let triedTokenRefresh = false;

  if (useAuth && hasSession()) {
    await ensureFreshToken();
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const clientId = await clientIdValue(forceClientId);
    forceClientId = false;

    const usedToken = useAuth ? token() : "";
    const headers = {};
    if (usedToken) headers.Authorization = "OAuth " + usedToken;
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);

    const response = await request(apiUrl(path, clientId, query), {
      method: options.method || "GET",
      headers,
      body,
    });

    if (response.status === 401) {
      // Another concurrent call may already have rotated the access token while
      // this request was in flight. Retry immediately with the new token.
      if (useAuth && usedToken && token() && token() !== usedToken) {
        continue;
      }

      // Rule out a stale client id before consuming the single-use refresh token.
      if (!triedClientIdRefresh) {
        triedClientIdRefresh = true;
        forceClientId = true;
        continue;
      }

      // With a fresh client id, a 401 means the access token expired or was
      // revoked. Try refreshing it once when a refresh token is stored.
      if (useAuth && usedToken && !triedTokenRefresh && refreshToken()) {
        triedTokenRefresh = true;
        const refreshed = await refreshAccessToken(usedToken);
        if (refreshed) continue;
      }

      if (useAuth && usedToken) {
        if (token() === usedToken) clearSession();
        throw fail(
          "signIn",
          t(
            "Your oauth_token stopped working: paste a new one in the settings",
          ),
        );
      }
      throw new Error(t("SoundCloud rejected the request"));
    }

    if (response.status === 404)
      throw fail("unavailable", t("SoundCloud has nothing at that address"));
    if (response.status === 403)
      throw fail("unavailable", t("SoundCloud will not play this"));
    if (response.status === 429)
      throw new Error(t("SoundCloud is rate limiting: try again later"));

    if (response.status < 200 || response.status >= 300) {
      const said =
        (response.data && response.data.errors && response.data.errors[0]) ||
        (response.data && response.data.message) ||
        `${t("SoundCloud answered")} ${response.status}`;
      throw new Error(String(said));
    }

    return response.data === null ? response.text : response.data;
  }

  throw new Error(t("SoundCloud rejected the request"));
}

// ---------------------------------------------------------------------------
// Client id

let clientIdCache = "";
let clientIdPromise = null;

async function clientIdValue(force = false) {
  if (!force && clientIdCache) return clientIdCache;

  if (!force) {
    const stored = host.storage.get("clientId");
    const at = Number(host.storage.get("clientIdAt") || 0);
    if (stored && Date.now() - at < CLIENT_ID_TTL) {
      clientIdCache = stored;
      return stored;
    }
  }

  if (clientIdPromise) return clientIdPromise;

  clientIdPromise = (async () => {
    const found = await scrapeClientId();
    clientIdCache = found;
    host.storage.set("clientId", found);
    host.storage.set("clientIdAt", Date.now());
    return found;
  })().finally(() => {
    clientIdPromise = null;
  });

  return clientIdPromise;
}

async function scrapeClientId() {
  const pages = [SITE + "/", SITE + "/discover"];
  let reachedPage = false;
  let lastError = null;

  for (const page of pages) {
    let html = "";
    try {
      const response = await request(page, {
        headers: { accept: "text/html" },
      });
      reachedPage = true;
      if (response.status !== 200) continue;
      html = response.text;
    } catch (error) {
      lastError = error;
      continue;
    }

    const scripts = [];
    const pattern = /<script[^>]+src="(https:\/\/[^"]+)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      if (match[1].includes("sndcdn")) scripts.push(match[1]);
    }

    for (const src of scripts.reverse()) {
      try {
        const asset = await request(src, {
          headers: { accept: "text/javascript" },
        });
        if (asset.status !== 200) continue;
        const found =
          asset.text.match(/client_id\s*:\s*["']([0-9a-zA-Z]{32})["']/) ||
          asset.text.match(/[?&]client_id=([0-9a-zA-Z]{32})\b/);
        if (found) return found[1];
      } catch (error) {
        lastError = error;
        // Another asset may have it.
      }
    }
  }

  if (!reachedPage && lastError) {
    throw new Error(t("Could not reach SoundCloud: check your network or proxy"));
  }

  throw new Error(t("Could not find SoundCloud's client id: try again later"));
}

// ---------------------------------------------------------------------------
// Session and token refresh

let meCache = null;
let sessionGen = 0;
let refreshPromise = null;
let refreshTimer = null;
let refreshRetryCount = 0;
let likedCursor = null;

function tokenExpiresAt() {
  const stored = Number(host.storage.get("tokenExpiresAt") || 0);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const fromJwt = jwtExpiryMs(token());
  if (fromJwt > 0) {
    host.storage.set("tokenExpiresAt", fromJwt);
    return fromJwt;
  }
  return 0;
}

function computeExpiresAt(accessToken, expiresIn) {
  const fromJwt = jwtExpiryMs(accessToken);
  if (fromJwt > 0) return fromJwt;
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Date.now() + seconds * 1000;
  }
  return 0;
}

function isTokenExpiringSoon(margin = TOKEN_REFRESH_MARGIN) {
  const exp = tokenExpiresAt();
  return exp > 0 && Date.now() >= exp - margin;
}

function isTokenExpired() {
  const exp = tokenExpiresAt();
  return exp > 0 && Date.now() >= exp;
}

function clearRefreshTimer() {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function clearSession() {
  sessionGen += 1;
  refreshRetryCount = 0;
  clearRefreshTimer();
  host.storage.remove("token");
  host.storage.remove("refreshToken");
  host.storage.remove("tokenExpiresAt");
  meCache = null;
  likedCursor = null;
}

function saveSession({ accessToken, refreshToken: nextRefresh, expiresIn }) {
  host.storage.set("token", accessToken);
  if (nextRefresh) {
    host.storage.set("refreshToken", nextRefresh);
  }
  const expiresAt = computeExpiresAt(accessToken, expiresIn);
  if (expiresAt > 0) {
    host.storage.set("tokenExpiresAt", expiresAt);
  } else {
    host.storage.remove("tokenExpiresAt");
  }
  refreshRetryCount = 0;
  scheduleRefresh();
}

function scheduleRefresh(overrideDelayMs) {
  clearRefreshTimer();
  if (!refreshToken() || !token()) return;

  let delay = overrideDelayMs;
  if (delay === undefined) {
    const exp = tokenExpiresAt();
    if (!exp) return;
    delay = Math.max(
      REFRESH_MIN_DELAY,
      Math.min(REFRESH_MAX_DELAY, exp - TOKEN_REFRESH_MARGIN - Date.now()),
    );
  }

  const gen = sessionGen;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (gen !== sessionGen || !refreshToken()) return;
    refreshAccessToken().catch((error) => {
      if (gen !== sessionGen) return;
      if (error && error.code === "signIn") return;
      // Keep the session on transient network/server errors and retry with backoff.
      refreshRetryCount += 1;
      const backoff = Math.min(
        REFRESH_RETRY_MAX,
        REFRESH_RETRY_BASE * Math.pow(2, Math.min(refreshRetryCount - 1, 4)),
      );
      scheduleRefresh(backoff);
    });
  }, delay);
}

// Exchanges a single-use refresh token at secure.soundcloud.com/oauth/token.
// SoundCloud binds web refresh tokens to the issuing client_id, which is
// carried in the JWT oauth_token when present.
async function requestTokenRefresh(rt, currentAccessToken) {
  if (!rt) {
    return {
      ok: false,
      permanent: false,
      error: t("Missing refresh token"),
    };
  }

  const tryExchange = async (clientId) => {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: rt,
    }).toString();

    return request(`${SECURE}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body,
    });
  };

  let clientId = jwtClientId(currentAccessToken) || (await clientIdValue(false));
  let response = await tryExchange(clientId);

  // If the client_id itself was rejected, scrape a fresh web client_id and
  // retry once. invalid_client fails before the refresh token is consumed.
  if (
    response.status === 401 &&
    response.data &&
    response.data.error === "invalid_client"
  ) {
    const freshClientId = await clientIdValue(true);
    if (freshClientId && freshClientId !== clientId) {
      clientId = freshClientId;
      response = await tryExchange(clientId);
    }
  }

  if (response.status === 200 && response.data && response.data.access_token) {
    return { ok: true, permanent: false, status: 200, data: response.data };
  }

  const errCode =
    response.data && typeof response.data.error === "string"
      ? response.data.error
      : "";
  const permanent =
    (response.status === 400 &&
      (errCode === "invalid_grant" || errCode === "invalid_token")) ||
    response.status === 401;

  const message =
    (response.data &&
      (response.data.error_description || response.data.error)) ||
    `${t("SoundCloud answered")} ${response.status}`;

  return {
    ok: false,
    permanent,
    status: response.status,
    error: String(message),
  };
}

// Single-flight refresh lock: SoundCloud refresh tokens are single-use, so
// concurrent requests must share one refresh call instead of racing.
async function refreshAccessToken(failedToken = "") {
  if (failedToken && token() && token() !== failedToken) {
    return token();
  }
  if (refreshPromise) return refreshPromise;

  const gen = sessionGen;
  refreshPromise = (async () => {
    if (failedToken && token() && token() !== failedToken) {
      return token();
    }

    const rt = refreshToken();
    if (!rt) return "";

    const result = await requestTokenRefresh(rt, token());

    // Ignore the response if the user signed out or changed settings meanwhile.
    if (gen !== sessionGen) return "";

    if (result.ok) {
      saveSession({
        accessToken: result.data.access_token,
        refreshToken: result.data.refresh_token || rt,
        expiresIn: result.data.expires_in,
      });
      return result.data.access_token;
    }

    if (result.permanent) {
      clearSession();
      throw fail(
        "signIn",
        t(
          "Your SoundCloud session expired: paste a new oauth_token and oauth_refresh_token in the settings",
        ),
      );
    }

    throw new Error(result.error || t("Could not refresh SoundCloud session"));
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function ensureFreshToken() {
  if (!refreshToken()) return;
  if (token() && !isTokenExpiringSoon()) return;

  try {
    await refreshAccessToken();
  } catch (error) {
    if (error && error.code === "signIn") throw error;
    // If the current token has not actually expired yet, allow the request to
    // proceed despite a transient refresh failure.
    if (token() && !isTokenExpired()) return;
    throw error;
  }
}

async function validateConnectSession(accessToken) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const clientId = await clientIdValue(attempt > 0);
    const response = await request(
      `${AUTH}/connect/session?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: { access_token: accessToken } }),
      },
    );
    if (response.status === 200) return true;
  }
  return false;
}

async function meNow() {
  if (meCache) return meCache;
  requireToken();
  const me = await api("/me");
  meCache = {
    id: String(me.id),
    name: me.username || me.full_name || "",
    imageUrl: image(me.avatar_url),
  };
  return meCache;
}

let mobiClientIdCache = "";

async function mobiClientIdValue() {
  if (mobiClientIdCache) return mobiClientIdCache;
  try {
    const response = await request(`${MOBI}/signin`, {
      headers: { accept: "text/html" },
    });
    if (response.status === 200) {
      const found =
        response.text.match(/"clientId"\s*:\s*"([0-9a-zA-Z]{32})"/) ||
        response.text.match(/client_id["']?\s*:\s*["']([0-9a-zA-Z]{32})["']/);
      if (found) {
        mobiClientIdCache = found[1];
        return mobiClientIdCache;
      }
    }
  } catch {
    // Fall back to the known mobile web client id.
  }
  return MOBI_CLIENT_ID_FALLBACK;
}

// Builds a top-level secure.soundcloud.com/web-auth URL that runs third-party
// providers (Google, Apple, Facebook) via same-window redirect instead of
// window.open popups (which embedded WebViews block), then bounces through
// m.soundcloud.com/signin/callback onto soundcloud.com so SoundCloud's own web
// bootstrap mints oauth_token + HttpOnly oauth_refresh_token cookies.
async function buildWebSignInUrl() {
  const mobiClientId = await mobiClientIdValue();
  const nonce = randomBase64Url(24);
  const state = encodeBase64(
    JSON.stringify({
      origin: SITE,
      path: "/discover",
      client_id: mobiClientId,
      nonce,
    }),
  );
  const params = new URLSearchParams({
    client_id: mobiClientId,
    device_id: randomDeviceId(),
    origin: MOBI,
    app_id: ANDROID_WEB_AUTH_APP_ID,
    redirect_uri: `${MOBI}/signin/callback`,
    response_type: "code",
    code_challenge: randomBase64Url(43),
    code_challenge_method: "S256",
    state,
    stand_alone: "true",
  });
  return `${SECURE}/web-auth?${params.toString()}`;
}

export async function signIn() {
  const rawToken = host.setting("oauthToken");
  const rawRefresh = host.setting("oauthRefreshToken");
  let access = readToken(rawToken);
  let refresh =
    readRefreshToken(rawRefresh) ||
    extractCookieFromHeader(rawToken, "oauth_refresh_token");
  let fromWebSignIn = false;

  const gen = ++sessionGen;
  clearRefreshTimer();
  meCache = null;
  likedCursor = null;

  if (!access && !refresh) {
    if (typeof host.webSignIn !== "function") {
      throw fail(
        "setup",
        t("Paste your oauth_token in the plugin settings, then sign in"),
      );
    }

    const authUrl = await buildWebSignInUrl();

    // Request cookies for /n/api/refresh-token so both Path=/ (oauth_token) and
    // path-scoped HttpOnly refresh cookies (oauth_refresh_token) are captured.
    const result = await host.webSignIn({
      url: authUrl,
      cookiesOf: `${SITE}/n/api/refresh-token`,
      until: ["oauth_token"],
      userAgent: BROWSER_UA,
    });
    const cookieHeader = (result && result.cookie) || "";
    access = extractCookieFromHeader(cookieHeader, "oauth_token");
    refresh = extractCookieFromHeader(cookieHeader, "oauth_refresh_token");
    fromWebSignIn = true;

    if (!access) {
      throw fail(
        "signIn",
        t("SoundCloud sign-in did not return a session: try again"),
      );
    }
  }

  let expiresIn = 0;
  let needsRefresh = !access;

  if (access && !fromWebSignIn) {
    const exp = jwtExpiryMs(access);
    if (exp > 0 && Date.now() >= exp && refresh) {
      needsRefresh = true;
    } else {
      const accepted = await validateConnectSession(access);
      if (!accepted) {
        if (refresh) {
          needsRefresh = true;
        } else {
          throw fail("signIn", t("SoundCloud rejected that oauth_token"));
        }
      }
    }
  }

  if (needsRefresh) {
    const refreshed = await requestTokenRefresh(refresh, access);
    if (!refreshed.ok) {
      if (refreshed.permanent) {
        throw fail(
          "signIn",
          t("SoundCloud rejected that oauth_refresh_token"),
        );
      }
      throw new Error(
        refreshed.error || t("Could not refresh SoundCloud session"),
      );
    }
    access = refreshed.data.access_token;
    if (refreshed.data.refresh_token) refresh = refreshed.data.refresh_token;
    expiresIn = Number(refreshed.data.expires_in) || 0;
  }

  if (gen !== sessionGen) {
    throw fail("signIn", t("Sign-in was interrupted"));
  }

  saveSession({ accessToken: access, refreshToken: refresh, expiresIn });

  try {
    const me = await meNow();
    return { id: me.id, name: me.name, imageUrl: me.imageUrl, page: "me" };
  } catch (error) {
    clearSession();
    if (error && error.code === "signIn") throw error;
    throw fail(
      "signIn",
      fromWebSignIn
        ? t("SoundCloud did not accept that sign-in: try again")
        : t("SoundCloud rejected that oauth_token"),
    );
  }
}

export function signOut() {
  clearSession();
}

export async function account() {
  if (!hasSession()) return null;
  try {
    const me = await meNow();
    return { id: me.id, name: me.name, imageUrl: me.imageUrl, page: "me" };
  } catch {
    return null;
  }
}

export function setSetting({ key, value }) {
  // A new token replaces the old session; signing in validates the new one.
  if (key === "oauthToken") {
    clearSession();
    return;
  }
  if (key === "oauthRefreshToken" && hasSession()) {
    const raw =
      value !== undefined ? value : host.setting("oauthRefreshToken");
    const rt = readRefreshToken(raw);
    if (rt) {
      host.storage.set("refreshToken", rt);
      scheduleRefresh();
    } else {
      host.storage.remove("refreshToken");
      clearRefreshTimer();
    }
  }
}

// Resume proactive background refresh when the plugin loads with a saved session.
scheduleRefresh();

// ---------------------------------------------------------------------------
// Mapping SoundCloud to what the app shows

function image(url, size = "t500x500") {
  if (!url) return "";
  return String(url).replace(
    /-[a-z0-9]+\.(jpg|jpeg|png|webp)$/i,
    `-${size}.$1`,
  );
}

function trackImage(track) {
  return image(track.artwork_url || (track.user && track.user.avatar_url));
}

function toArtist(user) {
  if (!user) return { id: "", name: "" };
  return {
    id: String(user.id !== undefined ? user.id : user.user_id || ""),
    name: user.username || user.full_name || "",
    imageUrl: image(user.avatar_url),
  };
}

// A track is playable when SoundCloud offers a stream the app can use: plain
// HLS (through ffmpeg) or an old progressive file. Encrypted HLS is DRM.
function playable(track) {
  if (!track || track.streamable === false) return false;
  if (track.policy === "BLOCK") return false;
  const protocols = (
    track.media && track.media.transcodings ? track.media.transcodings : []
  )
    .map((item) => (item.format ? item.format.protocol : ""))
    .filter(Boolean);
  if (!protocols.length) return true;
  return protocols.some(
    (protocol) => protocol === "hls" || protocol === "progressive",
  );
}

function toTrack(track, context) {
  if (!track || !track.id) return null;
  const artists = [toArtist(track.user)];
  let album;

  if (context) {
    album = {
      id: String(context.id),
      name: context.title || "",
      imageUrl:
        trackImage(track) ||
        image(context.artwork_url || (context.user && context.user.avatar_url)),
      artists: [toArtist(context.user)],
    };
  } else {
    const metadata = track.publisher_metadata || {};
    album = {
      id: "track:" + track.id,
      name: metadata.album_title || t("Single"),
      imageUrl: trackImage(track),
      artists,
      released: String(track.release_date || track.display_date || "").slice(
        0,
        10,
      ),
    };
  }

  return {
    id: String(track.id),
    name: track.title || "",
    artists,
    album,
    duration: Number(track.duration) || 0,
    url: track.permalink_url || "",
    unavailable: !playable(track),
  };
}

function toAlbum(playlist) {
  return {
    id: String(playlist.id),
    name: playlist.title || "",
    imageUrl: image(
      playlist.artwork_url || (playlist.user && playlist.user.avatar_url),
    ),
    artists: [toArtist(playlist.user)],
    released: String(
      playlist.release_date || playlist.display_date || "",
    ).slice(0, 10),
  };
}

// A playlist only carries full tracks for its first few entries; the rest come
// as `{id, kind, policy}` stubs. The batch endpoint fills them in, so the app
// never gets a row without a title.
async function hydrateTracks(entries) {
  const missing = [];
  for (const track of entries) {
    if (!track || !track.id) continue;
    if (!track.title || !track.user) missing.push(String(track.id));
  }

  const unique = [...new Set(missing)];
  const found = new Map();

  for (let at = 0; at < unique.length; at += 50) {
    const ids = unique.slice(at, at + 50);
    try {
      const data = await api("/tracks", { query: { ids: ids.join(",") } });
      if (Array.isArray(data)) {
        for (const track of data) {
          if (track && track.id) {
            found.set(String(track.id), track);
            rawTracks.set(String(track.id), { data: track, at: Date.now() });
          }
        }
      }
    } catch {
      // A batch that fails leaves its entries as they came.
    }
  }

  return entries.map((track) => {
    if (!track || !track.id) return null;
    if (track.title && track.user) return track;
    return found.get(String(track.id)) || null;
  });
}

async function playlistTracks(playlist) {
  const entries = (playlist.tracks || [])
    .map((item) => item.track || item)
    .filter((track) => track && track.id);
  const full = await hydrateTracks(entries);
  return full
    .filter((track) => track && track.title)
    .map((track) => toTrack(track, playlist))
    .filter(Boolean);
}

function toPlaylist(playlist, options = {}) {
  return {
    id: String(playlist.id),
    name: playlist.title || "",
    imageUrl: image(
      playlist.artwork_url || (playlist.user && playlist.user.avatar_url),
    ),
    description: playlist.description || "",
    owner: playlist.user ? playlist.user.username : "",
    trackCount: Number(playlist.track_count || 0),
    mine: !!options.mine,
    saved: !!options.saved,
  };
}

async function playlistPage(playlist, options = {}) {
  const result = toPlaylist(playlist, options);
  result.tracks = await playlistTracks(playlist);
  result.trackCount = result.tracks.length || result.trackCount;
  return result;
}

function collectTracks(value, out = [], seen = new Set(), depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return out;

  if (Array.isArray(value)) {
    for (const item of value) collectTracks(item, out, seen, depth + 1);
    return out;
  }

  if (
    value.kind === "track" &&
    value.id &&
    value.title &&
    !seen.has(String(value.id))
  ) {
    seen.add(String(value.id));
    out.push(value);
  }

  for (const key of [
    "track",
    "origin",
    "playlist",
    "items",
    "collection",
    "tracks",
    "data",
    "activities",
  ]) {
    if (value[key]) collectTracks(value[key], out, seen, depth + 1);
  }

  return out;
}

function tracksIn(response) {
  return dedupe(
    collectTracks(response)
      .map((track) => toTrack(track))
      .filter(Boolean),
  );
}

function hasMore(response, count) {
  if (!response) return false;
  if (response.next_href !== undefined) return !!response.next_href;
  return count >= PAGE;
}

// ---------------------------------------------------------------------------
// Track details, shared by playback and lyrics

const rawTracks = new Map();

async function rawTrack(id) {
  const key = String(id);
  const cached = rawTracks.get(key);
  if (cached && Date.now() - cached.at < TRACK_TTL) return cached.data;
  const data = await api(`/tracks/${encodeURIComponent(key)}`);
  rawTracks.set(key, { data, at: Date.now() });
  return data;
}

async function trackById(id) {
  return toTrack(await rawTrack(id));
}

// ---------------------------------------------------------------------------
// Home and pages of the plugin's own

async function trending(limit) {
  const response = await api("/charts", {
    query: { kind: "trending", genre: "soundcloud:genres:all-music", limit },
    auth: false,
  });
  return (response.collection || [])
    .map((item) => item.track || item)
    .filter(Boolean)
    .map((track) => toTrack(track))
    .filter(Boolean);
}

async function selectionPlaylists(limit) {
  const response = await api("/mixed-selections", {
    query: { limit },
    auth: false,
  });
  const out = [];
  for (const selection of response.collection || []) {
    const items =
      selection.items && selection.items.collection
        ? selection.items.collection
        : [];
    for (const playlist of items) out.push(toPlaylist(playlist));
  }
  return out.slice(0, limit * 3);
}

export async function home() {
  const sections = [];

  if (hasSession()) {
    const me = await meNow().catch(() => null);

    if (me) {
      const [stream, recent, playlists, likes] = await Promise.allSettled([
        api("/stream", { query: { limit: 12, linked_partitioning: 1 } }),
        api("/me/play-history/tracks", {
          query: { limit: 12, linked_partitioning: 1 },
        }),
        api(`/users/${me.id}/playlists`, {
          query: { limit: 12, linked_partitioning: 1 },
        }),
        api(`/users/${me.id}/track_likes`, {
          query: { limit: 12, linked_partitioning: 1 },
        }),
      ]);

      if (stream.status === "fulfilled") {
        const tracks = tracksIn(stream.value);
        if (tracks.length) sections.push({ title: t("Your Stream"), tracks });
      }

      if (recent.status === "fulfilled") {
        const tracks = tracksIn(recent.value);
        if (tracks.length)
          sections.push({
            title: t("Recently Played"),
            tracks,
            morePage: "recent",
          });
      }

      if (playlists.status === "fulfilled") {
        const mine = (playlists.value.collection || [])
          .filter((playlist) => !playlist.is_album)
          .map((playlist) => toPlaylist(playlist, { mine: true }));
        if (mine.length)
          sections.push({ title: t("Your Playlists"), playlists: mine });
      }

      if (likes.status === "fulfilled") {
        const tracks = (likes.value.collection || [])
          .map((item) => toTrack(item.track))
          .filter(Boolean);
        if (tracks.length) sections.push({ title: t("Liked Tracks"), tracks });
      }
    }
  }

  try {
    const tracks = await trending(20);
    if (tracks.length)
      sections.push({ title: t("Trending Now"), tracks, morePage: "charts" });
  } catch {
    // Home still shows what the account gave.
  }

  if (!sections.length) {
    sections.push({
      title: t("Trending Now"),
      tracks: [],
      empty: t("Nothing to show right now"),
    });
  }

  return { title: t("SoundCloud"), sections };
}

export async function browse({ page }) {
  if (page === "charts") {
    const sections = [];
    const tracks = await trending(50);
    if (tracks.length) sections.push({ title: t("Trending Now"), tracks });

    try {
      const playlists = await selectionPlaylists(6);
      if (playlists.length)
        sections.push({ title: t("Selections"), playlists });
    } catch {
      // Charts alone are enough.
    }

    return {
      title: t("Charts"),
      subtitle: t("What SoundCloud is playing"),
      sections,
    };
  }

  if (page === "following") {
    requireToken();
    const me = await meNow();
    const response = await api(`/users/${me.id}/followings`, {
      query: { limit: 100, linked_partitioning: 1 },
    });
    const artists = (response.collection || []).map((user) => toArtist(user));
    return {
      title: t("Following"),
      sections: [
        {
          title: t("Artists"),
          artists,
          empty: t("You do not follow anyone yet"),
        },
      ],
    };
  }

  if (page === "me") {
    requireToken();
    const me = await meNow();
    const [profile, playlists, likes] = await Promise.allSettled([
      api(`/users/${me.id}`),
      api(`/users/${me.id}/playlists`, {
        query: { limit: 24, linked_partitioning: 1 },
      }),
      api(`/users/${me.id}/track_likes`, {
        query: { limit: 12, linked_partitioning: 1 },
      }),
    ]);

    const sections = [];

    if (playlists.status === "fulfilled") {
      const mine = (playlists.value.collection || [])
        .filter((playlist) => !playlist.is_album)
        .map((playlist) => toPlaylist(playlist, { mine: true }));
      if (mine.length)
        sections.push({ title: t("Your Playlists"), playlists: mine });
    }

    if (likes.status === "fulfilled") {
      const tracks = (likes.value.collection || [])
        .map((item) => toTrack(item.track))
        .filter(Boolean);
      if (tracks.length)
        sections.push({ title: t("Liked Tracks"), tracks, morePage: "liked" });
    }

    if (profile.status === "fulfilled") {
      const tracks = await api(`/users/${me.id}/tracks`, {
        query: { limit: 20, linked_partitioning: 1 },
      })
        .then((response) =>
          (response.collection || [])
            .map((track) => toTrack(track))
            .filter(Boolean),
        )
        .catch(() => []);
      if (tracks.length) sections.push({ title: t("Your Tracks"), tracks });
    }

    return { title: me.name, imageUrl: me.imageUrl, sections };
  }

  if (page === "recent") {
    const tracks = await recent();
    return {
      title: t("Recently Played"),
      sections: [
        { title: t("Recently Played"), tracks, empty: t("Nothing played yet") },
      ],
    };
  }

  throw fail("unavailable", t("No such page"));
}

// ---------------------------------------------------------------------------
// Search

export async function search({ query, kind, offset = 0 }) {
  const paths = {
    tracks: "/search/tracks",
    albums: "/search/albums",
    artists: "/search/users",
    playlists: "/search/playlists",
  };

  const path = paths[kind];
  if (!path) return { [kind]: [], more: false };

  const response = await api(path, {
    query: { q: query, limit: PAGE, offset },
    auth: false,
  });
  const collection = response.collection || [];

  if (kind === "tracks") {
    const tracks = collection.map((track) => toTrack(track)).filter(Boolean);
    return { tracks, more: hasMore(response, tracks.length) };
  }
  if (kind === "albums") {
    const albums = collection.map((album) => toAlbum(album));
    return { albums, more: hasMore(response, albums.length) };
  }
  if (kind === "artists") {
    const artists = collection.map((user) => toArtist(user));
    return { artists, more: hasMore(response, artists.length) };
  }

  const playlists = collection.map((playlist) => toPlaylist(playlist));
  return { playlists, more: hasMore(response, playlists.length) };
}

export async function suggest({ query }) {
  try {
    const response = await api("/search/queries", {
      query: { q: query, limit: 8 },
      auth: false,
    });
    return (response.collection || [])
      .map((item) => item.output || item.query || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Library

export async function playlists() {
  if (!hasSession()) return [];
  const me = await meNow();

  const [mine, likes] = await Promise.allSettled([
    api(`/users/${me.id}/playlists`, {
      query: { limit: 200, linked_partitioning: 1 },
    }),
    api(`/users/${me.id}/likes`, {
      query: { limit: 200, linked_partitioning: 1 },
    }),
  ]);

  const out = [];
  const seen = new Set();

  if (mine.status === "fulfilled") {
    for (const playlist of mine.value.collection || []) {
      if (playlist.is_album) continue;
      const mapped = toPlaylist(playlist, { mine: true });
      if (seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      out.push(mapped);
    }
  }

  if (likes.status === "fulfilled") {
    for (const item of likes.value.collection || []) {
      if (!item.playlist) continue;
      const mapped = toPlaylist(item.playlist, { saved: true });
      if (seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      out.push(mapped);
    }
  }

  return out;
}

export async function playlist({ id }) {
  const me = await meNow().catch(() => null);
  const data = await api(`/playlists/${encodeURIComponent(id)}`);
  const mine = !!(me && data.user && String(data.user.id) === me.id);
  return playlistPage(data, { mine });
}

export async function album({ id }) {
  if (String(id).startsWith("track:")) {
    const track = toTrack(await rawTrack(String(id).slice(6)));
    return { album: track.album, tracks: track ? [track] : [] };
  }

  const data = await api(`/playlists/${encodeURIComponent(id)}`);
  return { album: toAlbum(data), tracks: await playlistTracks(data) };
}

export async function artist({ id }) {
  const user = await api(`/users/${encodeURIComponent(id)}`);
  const [tracks, playlists] = await Promise.allSettled([
    api(`/users/${encodeURIComponent(id)}/tracks`, {
      query: { limit: 50, linked_partitioning: 1 },
    }),
    api(`/users/${encodeURIComponent(id)}/playlists`, {
      query: { limit: 24, linked_partitioning: 1 },
    }),
  ]);

  const top =
    tracks.status === "fulfilled"
      ? (tracks.value.collection || [])
          .map((track) => toTrack(track))
          .filter(Boolean)
      : [];

  const albums =
    playlists.status === "fulfilled"
      ? (playlists.value.collection || [])
          .filter((item) => item.is_album)
          .map((item) => toAlbum(item))
      : [];

  return { artist: toArtist(user), tracks: top, albums };
}

export async function liked({ offset = 0 } = {}) {
  requireToken();
  const me = await meNow();

  // SoundCloud's /users/:id/track_likes uses opaque timestamp cursors in
  // next_href and rejects numeric offsets > 0 with 400 (ChronoParams.Cursor).
  let response;
  if (offset <= 0) {
    likedCursor = null;
    response = await api(`/users/${me.id}/track_likes`, {
      query: { limit: PAGE, linked_partitioning: 1 },
    });
  } else if (likedCursor && Math.abs(offset - likedCursor.at) <= 5) {
    response = await api(likedCursor.href);
  } else {
    const all = [];
    let nextPath = `/users/${me.id}/track_likes`;
    let query = { limit: 50, linked_partitioning: 1 };
    for (
      let page = 0;
      page < 20 && nextPath && all.length < offset + PAGE;
      page++
    ) {
      const batch = await api(nextPath, { query });
      for (const item of batch.collection || []) {
        const mapped = toTrack(item.track);
        if (mapped) all.push(mapped);
      }
      nextPath = batch.next_href || "";
      query = undefined;
    }
    const tracks = all.slice(offset, offset + PAGE);
    likedCursor =
      nextPath && all.length >= offset + PAGE
        ? { at: all.length, href: nextPath }
        : null;
    return { tracks, more: all.length > offset + PAGE || !!nextPath };
  }

  const tracks = (response.collection || [])
    .map((item) => toTrack(item.track))
    .filter(Boolean);
  const nextHref = response.next_href || "";
  likedCursor = nextHref
    ? { at: offset + tracks.length, href: nextHref }
    : null;
  return { tracks, more: !!nextHref };
}

// ---------------------------------------------------------------------------
// Listening history

export async function recent() {
  const local = load("history", []);
  let remote = [];

  if (hasSession()) {
    try {
      const response = await api("/me/play-history/tracks", {
        query: { limit: 50, linked_partitioning: 1 },
      });
      remote = collectTracks(response).map((track) => String(track.id));
    } catch {
      // The machine's own history still answers.
    }
  }

  const ids = [];
  for (const item of remote.concat(local.map((id) => String(id)))) {
    if (!item || ids.includes(item)) continue;
    ids.push(item);
  }

  const tracks = await Promise.all(
    ids.slice(0, 30).map((id) => trackById(id).catch(() => null)),
  );
  return tracks.filter(Boolean);
}

export function played({ id }) {
  if (!id) return;
  const key = String(id);
  const history = load("history", []).filter((item) => String(item) !== key);
  history.unshift(key);
  save("history", history.slice(0, HISTORY_MAX));
}

// ---------------------------------------------------------------------------
// Lyrics: SoundCloud has none, so LRCLIB is asked by title, artist and length.

const lyricCache = new Map();

async function lrclib(path) {
  const response = await request(LRCLIB + path, {
    headers: { "user-agent": "mygo-soundcloud/0.1.2 (MyGo Music plugin)" },
  });
  if (response.status === 404) return null;
  if (response.status !== 200) return null;
  return response.data;
}

function lyricsFrom(found, seconds) {
  if (!found) return null;
  if (found.syncedLyrics) return { lrc: found.syncedLyrics };
  if (found.plainLyrics) return { lrc: spreadLrc(found.plainLyrics, seconds) };
  return null;
}

function spreadLrc(plain, seconds) {
  const lines = String(plain)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const step = (seconds * 1000) / (lines.length + 1);
  return lines
    .map((line, index) => {
      const at = Math.round(step * (index + 1));
      const minutes = String(Math.floor(at / 60000)).padStart(2, "0");
      const rest = String(Math.floor((at % 60000) / 1000)).padStart(2, "0");
      const hundredths = String(Math.floor((at % 1000) / 10)).padStart(2, "0");
      return `[${minutes}:${rest}.${hundredths}]${line}`;
    })
    .join("\n");
}

function normalizeName(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Uploaders often put their own name, with "official" or "VEVO" on it, where
// the artist belongs. The publisher metadata is better when it is there.
function cleanUploader(name) {
  return String(name || "")
    .replace(/\b(official|vevo|music|records|recordings|tv|hq|audio)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lyricNames(track) {
  const metadata = track.publisher_metadata || {};
  const uploader = (track.user && track.user.username) || "";
  let title = String(track.title || "").trim();
  let artist = String(metadata.artist || "").trim();

  const split = title.match(/^(.{2,60}?)\s+-\s+(.{2,140})$/);
  if (!artist && split) {
    artist = split[1].trim();
    title = split[2].trim();
  }

  title = title
    .replace(/\s*[\(\[](?:feat\.|ft\.|featuring|with)[^\)\]]*[\)\]]/gi, "")
    .replace(/\s+(?:official\s+)?(?:video|audio|lyrics?|visuali[sz]er)\b/gi, "")
    .trim();

  const artists = [artist, metadata.artist, uploader, cleanUploader(uploader)]
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .filter((name, index, all) => all.indexOf(name) === index);

  return {
    title,
    artists,
    seconds: Math.round((Number(track.duration) || 0) / 1000),
  };
}

// The closest result whose name holds the title, with the length as a tiebreak.
// A SoundCloud preview is shorter than the song, so the length only counts when
// the track is a real one.
function bestLyrics(list, title, seconds) {
  const wanted = normalizeName(title);
  const scored = [];

  for (const item of list || []) {
    if (!item.syncedLyrics && !item.plainLyrics) continue;
    const name = normalizeName(item.trackName);
    const gap = seconds >= 60 ? Math.abs((item.duration || 0) - seconds) : 0;
    scored.push({
      item,
      score: (wanted && name.includes(wanted) ? 1000 : 0) - gap,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].item : null;
}

export async function lyrics({ id }) {
  const key = String(id);
  if (lyricCache.has(key)) return lyricCache.get(key);

  let result = {};
  try {
    const track = await rawTrack(key);
    const { title, artists, seconds } = lyricNames(track);
    let found = null;

    for (const artist of artists) {
      const exact = await lrclib(
        `/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(
          title,
        )}&duration=${seconds}`,
      );
      found = lyricsFrom(exact, seconds);
      if (found) break;
    }

    if (!found) {
      const candidates = [];

      for (const artist of artists) {
        const list = await lrclib(
          `/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(
            title,
          )}`,
        );
        if (Array.isArray(list)) candidates.push(...list);
      }

      const query = [artists[0] || "", title].filter(Boolean).join(" ").trim();
      if (query) {
        const list = await lrclib(`/api/search?q=${encodeURIComponent(query)}`);
        if (Array.isArray(list)) candidates.push(...list);
      }

      const best = bestLyrics(candidates, title, seconds);
      if (best) found = lyricsFrom(best, seconds);
    }

    if (found) result = found;
  } catch {
    result = {};
  }

  lyricCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Playing

let helperProc = null;
let helperPort = 0;
let helperStarting = null;
let helperMissing = false;

function helperCandidates() {
  const ext = host.platform === "windows" ? ".exe" : "";
  const list = [`bin/hls-helper${ext}`];
  if (host.platform && host.arch) {
    list.unshift(`bin/hls-helper-${host.platform}-${host.arch}${ext}`);
  }
  return list;
}

async function readLineWithTimeout(proc, ms) {
  let timer = null;
  try {
    return await Promise.race([
      proc.readLine(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("helper startup timeout")), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function startHelper() {
  if (helperProc && helperPort) return helperPort;
  if (helperMissing) return 0;
  if (helperStarting) return helperStarting;

  helperStarting = (async () => {
    for (const path of helperCandidates()) {
      let proc = null;
      try {
        proc = host.spawn(path, []);
        const line = await readLineWithTimeout(proc, 5000);
        if (!line) {
          try {
            proc.kill();
          } catch {
            // already exited
          }
          continue;
        }
        const info = JSON.parse(line);
        const port = Number(info && info.port);
        if (!Number.isInteger(port) || port <= 0) {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          continue;
        }
        helperProc = proc;
        helperPort = port;
        proc.wait().then(() => {
          if (helperProc === proc) {
            helperProc = null;
            helperPort = 0;
          }
        });
        return port;
      } catch (error) {
        if (proc) {
          try {
            proc.kill();
          } catch {
            // ignore
          }
        }
        if (error && /allowed/.test(error.message)) {
          throw fail(
            "setup",
            t("Allow SoundCloud to start programs in its settings"),
          );
        }
      }
    }
    helperMissing = true;
    return 0;
  })().finally(() => {
    helperStarting = null;
  });

  return helperStarting;
}

async function serveWithHelper(playlist) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = await startHelper();
    if (!port) {
      throw fail(
        "setup",
        t(
          "SoundGo's built-in HLS helper is missing: reinstall the platform release ZIP",
        ),
      );
    }

    try {
      const response = await request(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: playlist }),
      });
      if (response.status === 200 && response.data && response.data.url) {
        return {
          url: response.data.url,
          type: response.data.type || "aac",
        };
      }
      const reason =
        (response.data && response.data.error) ||
        t("SoundCloud did not give out a stream for this track");
      throw fail("unavailable", String(reason));
    } catch (error) {
      if (error && error.code) throw error;
      // Helper may have exited; reset and retry spawning once.
      if (helperProc) {
        try {
          helperProc.kill();
        } catch {
          // ignore
        }
      }
      helperProc = null;
      helperPort = 0;
    }
  }
  throw new Error(t("The audio did not start"));
}

function pickTranscoding(track) {
  const transcodings = (track.media && track.media.transcodings) || [];
  const usable = transcodings.filter((item) => {
    const protocol = item.format && item.format.protocol;
    return protocol === "hls" || protocol === "progressive";
  });

  const rank = (item) => {
    if (item.preset === "aac_160k") return 0;
    if (item.preset === "aac_96k") return 1;
    if (item.preset === "mp3_128") return 2;
    return 3;
  };

  usable.sort((a, b) => rank(a) - rank(b));
  return usable[0] || null;
}

async function resolveMedia(track, transcoding) {
  const response = await api(transcoding.url, {
    query: { track_authorization: track.track_authorization || "" },
  });
  if (!response || !response.url) {
    throw fail(
      "unavailable",
      t("SoundCloud did not give out a stream for this track"),
    );
  }
  return response.url;
}

export async function stream({ id, quality }) {
  const track = await rawTrack(id);
  const transcoding = pickTranscoding(track);

  if (!transcoding) {
    throw fail(
      "unavailable",
      t(
        "This track is encrypted with DRM, so SoundCloud will not let a plugin play it",
      ),
    );
  }

  const media = await resolveMedia(track, transcoding);
  const protocol = transcoding.format && transcoding.format.protocol;

  if (protocol === "progressive") {
    const mime = (transcoding.format && transcoding.format.mime_type) || "";
    const type = mime.includes("mpeg")
      ? "mp3"
      : mime.includes("mp4")
        ? "m4a"
        : "mp3";
    return { url: media, type, quality: quality || "high" };
  }

  const relayed = await serveWithHelper(media);
  const presetBitRate =
    transcoding.preset === "aac_160k"
      ? 160000
      : transcoding.preset === "aac_96k"
        ? 96000
        : transcoding.preset === "mp3_128"
          ? 128000
          : undefined;
  return {
    url: relayed.url,
    type: relayed.type,
    quality: quality === "standard" ? "standard" : "high",
    ...(presetBitRate ? { bitRate: presetBitRate } : {}),
  };
}
