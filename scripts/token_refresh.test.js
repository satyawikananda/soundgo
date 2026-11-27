// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 SoundGo contributors

import { afterEach, describe, expect, test } from "bun:test";

const origFetch = globalThis.fetch;
const origHost = globalThis.host;
const origAtob = globalThis.atob;
const origBtoa = globalThis.btoa;

let caseSeq = 0;
const loadedPlugins = [];

function makeJwt(payload) {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

function jsonResponse(status, body) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function setupPlugin({
  storage = {},
  settings = {},
  fetchImpl,
  webSignInImpl,
  spawnImpl,
  hideAtob = false,
}) {
  const store = new Map(Object.entries(storage));
  const settingMap = new Map(Object.entries(settings));

  globalThis.host = {
    platform: "windows",
    arch: "amd64",
    t: (s) => s,
    language: () => "en",
    setting: (key) => settingMap.get(key) || "",
    storage: {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      remove: (key) => store.delete(key),
    },
    ...(webSignInImpl ? { webSignIn: webSignInImpl } : {}),
    spawn:
      spawnImpl ||
      (() => {
        throw new Error("spawn not mocked");
      }),
  };
  globalThis.fetch = fetchImpl;
  if (hideAtob) {
    globalThis.atob = undefined;
    globalThis.btoa = undefined;
  }

  caseSeq += 1;
  const plugin = await import(`../index.js?case=${caseSeq}`);
  loadedPlugins.push(plugin);
  return { plugin, store, settingMap };
}

afterEach(() => {
  while (loadedPlugins.length) {
    try {
      loadedPlugins.pop().signOut();
    } catch {
      // ignore cleanup errors
    }
  }
  globalThis.fetch = origFetch;
  globalThis.host = origHost;
  globalThis.atob = origAtob;
  globalThis.btoa = origBtoa;
});

describe("SoundGo automatic token refresh", () => {
  test("signIn extracts oauth_token and oauth_refresh_token from a full Cookie header without atob", async () => {
    const expSec = Math.floor((Date.now() + 3600 * 1000) / 1000);
    const accessJwt = makeJwt({ exp: expSec, client_id: "JWT_CLIENT_ID_123456789012345678" });

    const { plugin, store } = await setupPlugin({
      hideAtob: true,
      storage: { clientId: "WEB_CLIENT_ID_123456789012345678", clientIdAt: Date.now() },
      settings: {
        oauthToken: `sc_anonymous_id=123; oauth_token=${accessJwt}; oauth_refresh_token=rt_initial_1`,
      },
      fetchImpl: async (url) => {
        if (url.includes("/connect/session")) return jsonResponse(200, { ok: true });
        if (url.includes("/me")) {
          return jsonResponse(200, { id: 42, username: "alice", avatar_url: "" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const acc = await plugin.signIn();
    expect(acc).toEqual({ id: "42", name: "alice", imageUrl: "", page: "me" });
    expect(store.get("token")).toBe(accessJwt);
    expect(store.get("refreshToken")).toBe("rt_initial_1");
    expect(store.get("tokenExpiresAt")).toBe(expSec * 1000);
  });

  test("signIn automatically refreshes an already-expired oauth_token when oauth_refresh_token is provided", async () => {
    const expiredJwt = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      client_id: "JWT_CLIENT_ID_123456789012345678",
    });
    const freshExpSec = Math.floor((Date.now() + 3600 * 1000) / 1000);
    const freshJwt = makeJwt({
      exp: freshExpSec,
      client_id: "JWT_CLIENT_ID_123456789012345678",
    });

    let tokenCalls = 0;
    let receivedForm = null;
    const { plugin, store } = await setupPlugin({
      storage: { clientId: "WEB_CLIENT_ID_123456789012345678", clientIdAt: Date.now() },
      settings: {
        oauthToken: expiredJwt,
        oauthRefreshToken: "rt_old",
      },
      fetchImpl: async (url, init) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          tokenCalls += 1;
          receivedForm = new URLSearchParams(init.body);
          return jsonResponse(200, {
            access_token: freshJwt,
            refresh_token: "rt_rotated",
            expires_in: 3600,
          });
        }
        if (url.includes("/me")) {
          expect(init.headers.Authorization).toBe("OAuth " + freshJwt);
          return jsonResponse(200, { id: 7, username: "bob", avatar_url: "" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const acc = await plugin.signIn();
    expect(acc.name).toBe("bob");
    expect(tokenCalls).toBe(1);
    expect(receivedForm.get("client_id")).toBe("JWT_CLIENT_ID_123456789012345678");
    expect(receivedForm.get("grant_type")).toBe("refresh_token");
    expect(receivedForm.get("refresh_token")).toBe("rt_old");
    expect(store.get("token")).toBe(freshJwt);
    expect(store.get("refreshToken")).toBe("rt_rotated");
    expect(store.get("tokenExpiresAt")).toBe(freshExpSec * 1000);
  });

  test("signIn succeeds when only oauth_refresh_token is provided", async () => {
    const freshJwt = makeJwt({ exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });

    const { plugin, store } = await setupPlugin({
      storage: { clientId: "WEB_CLIENT_ID_123456789012345678", clientIdAt: Date.now() },
      settings: { oauthRefreshToken: "rt_only" },
      fetchImpl: async (url) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          return jsonResponse(200, {
            access_token: freshJwt,
            refresh_token: "rt_only_next",
            expires_in: 3600,
          });
        }
        if (url.includes("/me")) {
          return jsonResponse(200, { id: 9, username: "carol", avatar_url: "" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const acc = await plugin.signIn();
    expect(acc.id).toBe("9");
    expect(store.get("token")).toBe(freshJwt);
    expect(store.get("refreshToken")).toBe("rt_only_next");
  });

  test("proactive refresh rotates single-use refresh token once across concurrent requests", async () => {
    const soonExpiringJwt = makeJwt({
      exp: Math.floor((Date.now() + 60_000) / 1000), // inside 5-min margin
      client_id: "JWT_CLIENT_ID_123456789012345678",
    });
    const nextJwt = makeJwt({
      exp: Math.floor((Date.now() + 3600 * 1000) / 1000),
      client_id: "JWT_CLIENT_ID_123456789012345678",
    });

    let refreshCount = 0;
    const seenAuthHeaders = [];
    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: "WEB_CLIENT_ID_123456789012345678",
        clientIdAt: Date.now(),
        token: soonExpiringJwt,
        refreshToken: "rt_single_use_1",
      },
      fetchImpl: async (url, init) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          refreshCount += 1;
          await new Promise((r) => setTimeout(r, 25));
          return jsonResponse(200, {
            access_token: nextJwt,
            refresh_token: "rt_single_use_2",
            expires_in: 3600,
          });
        }
        seenAuthHeaders.push(init.headers.Authorization);
        if (url.includes("/me")) {
          return jsonResponse(200, { id: 1, username: "u", avatar_url: "" });
        }
        if (url.includes("/users/1/playlists") || url.includes("/users/1/likes")) {
          return jsonResponse(200, { collection: [] });
        }
        return jsonResponse(200, { collection: [] });
      },
    });

    // Fire multiple concurrent calls (playlists internally fans out too)
    await Promise.all([plugin.playlists(), plugin.playlists(), plugin.account()]);

    expect(refreshCount).toBe(1);
    expect(store.get("token")).toBe(nextJwt);
    expect(store.get("refreshToken")).toBe("rt_single_use_2");
    expect(seenAuthHeaders.length).toBeGreaterThan(0);
    for (const h of seenAuthHeaders) {
      expect(h).toBe("OAuth " + nextJwt);
    }
  });

  test("reactive 401 checks fresh client_id first before consuming single-use refresh_token", async () => {
    const validJwt = makeJwt({ exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });
    let refreshCount = 0;
    let scrapeCount = 0;
    const staleCid = "StaleClientId1234567890123456789";
    const freshCid = "FreshClientId1234567890123456789";

    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: staleCid,
        clientIdAt: Date.now(),
        token: validJwt,
        refreshToken: "rt_untouched",
      },
      fetchImpl: async (url) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          refreshCount += 1;
          return jsonResponse(400, { error: "invalid_grant" });
        }
        if (url === "https://soundcloud.com/") {
          scrapeCount += 1;
          return new Response('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>', { status: 200 });
        }
        if (url === "https://a-v2.sndcdn.com/assets/app.js") {
          return new Response(`client_id:"${freshCid}"`, { status: 200 });
        }
        if (url.includes(staleCid)) return jsonResponse(401, {});
        if (url.includes("/me") && url.includes(freshCid)) {
          return jsonResponse(200, { id: 5, username: "ok", avatar_url: "" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const acc = await plugin.account();
    expect(acc.name).toBe("ok");
    expect(scrapeCount).toBe(1);
    expect(refreshCount).toBe(0);
    expect(store.get("refreshToken")).toBe("rt_untouched");
  });

  test("reactive 401 refreshes access token when client_id is valid and token was revoked early", async () => {
    const oldJwt = makeJwt({ sub: "old", exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });
    const newJwt = makeJwt({ sub: "new", exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });
    const goodCid = "GoodClientId12345678901234567890";
    let refreshCount = 0;

    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: goodCid,
        clientIdAt: Date.now(),
        token: oldJwt,
        refreshToken: "rt_revoked_case_1",
      },
      fetchImpl: async (url, init) => {
        if (url === "https://soundcloud.com/") {
          return new Response('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>', { status: 200 });
        }
        if (url === "https://a-v2.sndcdn.com/assets/app.js") {
          return new Response(`client_id:"${goodCid}"`, { status: 200 });
        }
        if (url === "https://secure.soundcloud.com/oauth/token") {
          refreshCount += 1;
          return jsonResponse(200, {
            access_token: newJwt,
            refresh_token: "rt_revoked_case_2",
            expires_in: 3600,
          });
        }
        if (url.includes("/me")) {
          if (init.headers.Authorization === "OAuth " + oldJwt) {
            return jsonResponse(401, {});
          }
          if (init.headers.Authorization === "OAuth " + newJwt) {
            return jsonResponse(200, { id: 10, username: "recovered", avatar_url: "" });
          }
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const acc = await plugin.account();
    expect(acc.name).toBe("recovered");
    expect(refreshCount).toBe(1);
    expect(store.get("token")).toBe(newJwt);
    expect(store.get("refreshToken")).toBe("rt_revoked_case_2");
  });

  test("refresh retries once with freshly scraped client_id on 401 invalid_client", async () => {
    const oldCid = "OldClientId123456789012345678901";
    const newCid = "NewClientId123456789012345678901";
    const expiredJwt = makeJwt({
      exp: Math.floor((Date.now() - 10_000) / 1000),
      client_id: oldCid,
    });
    const newJwt = makeJwt({ exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });
    const triedClientIds = [];

    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: oldCid,
        clientIdAt: Date.now(),
        token: expiredJwt,
        refreshToken: "rt_client_retry",
      },
      fetchImpl: async (url, init) => {
        if (url === "https://soundcloud.com/") {
          return new Response('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>', { status: 200 });
        }
        if (url === "https://a-v2.sndcdn.com/assets/app.js") {
          return new Response(`client_id:"${newCid}"`, { status: 200 });
        }
        if (url === "https://secure.soundcloud.com/oauth/token") {
          const cid = new URLSearchParams(init.body).get("client_id");
          triedClientIds.push(cid);
          if (cid === oldCid) {
            return jsonResponse(401, { error: "invalid_client" });
          }
          return jsonResponse(200, {
            access_token: newJwt,
            refresh_token: "rt_client_retry_2",
            expires_in: 3600,
          });
        }
        if (url.includes("/me")) {
          return jsonResponse(200, { id: 12, username: "ok", avatar_url: "" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const acc = await plugin.account();
    expect(acc.id).toBe("12");
    expect(triedClientIds).toEqual([oldCid, newCid]);
    expect(store.get("refreshToken")).toBe("rt_client_retry_2");
  });

  test("transient 503 during refresh preserves stored token and refreshToken", async () => {
    const expiredJwt = makeJwt({ exp: Math.floor((Date.now() - 10_000) / 1000) });

    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: "WEB_CLIENT_ID_123456789012345678",
        clientIdAt: Date.now(),
        token: expiredJwt,
        refreshToken: "rt_keep_me",
      },
      fetchImpl: async (url) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          return jsonResponse(503, { error: "temporarily_unavailable" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    await expect(plugin.liked()).rejects.toThrow();
    expect(store.get("token")).toBe(expiredJwt);
    expect(store.get("refreshToken")).toBe("rt_keep_me");
  });

  test("permanent invalid_grant during refresh clears session and throws signIn error", async () => {
    const expiredJwt = makeJwt({ exp: Math.floor((Date.now() - 10_000) / 1000) });

    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: "WEB_CLIENT_ID_123456789012345678",
        clientIdAt: Date.now(),
        token: expiredJwt,
        refreshToken: "rt_dead",
      },
      fetchImpl: async (url) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          return jsonResponse(400, { error: "invalid_grant" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    let err = null;
    try {
      await plugin.liked();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe("signIn");
    expect(store.get("token")).toBeUndefined();
    expect(store.get("refreshToken")).toBeUndefined();
    expect(store.get("tokenExpiresAt")).toBeUndefined();
  });

  test("signOut while refresh is in flight prevents stale tokens from being saved back", async () => {
    const expiredJwt = makeJwt({ exp: Math.floor((Date.now() - 10_000) / 1000) });
    const lateJwt = makeJwt({ exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });

    let releaseRefresh;
    const refreshStarted = new Promise((r) => {
      releaseRefresh = r;
    });
    let resolveFetch;

    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: "WEB_CLIENT_ID_123456789012345678",
        clientIdAt: Date.now(),
        token: expiredJwt,
        refreshToken: "rt_racing",
      },
      fetchImpl: async (url) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          releaseRefresh();
          return new Promise((resolve) => {
            resolveFetch = () =>
              resolve(
                jsonResponse(200, {
                  access_token: lateJwt,
                  refresh_token: "rt_should_be_discarded",
                  expires_in: 3600,
                }),
              );
          });
        }
        return jsonResponse(401, {});
      },
    });

    const pending = plugin.account();
    await refreshStarted;
    plugin.signOut();
    resolveFetch();
    const acc = await pending;

    expect(acc).toBeNull();
    expect(store.get("token")).toBeUndefined();
    expect(store.get("refreshToken")).toBeUndefined();
  });

  test("setSetting oauthRefreshToken attaches refresh token to an already active session", async () => {
    const soonExpiringJwt = makeJwt({ exp: Math.floor((Date.now() + 60_000) / 1000) });
    const rotatedJwt = makeJwt({ exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });

    const { plugin, store } = await setupPlugin({
      storage: {
        clientId: "WEB_CLIENT_ID_123456789012345678",
        clientIdAt: Date.now(),
        token: soonExpiringJwt,
      },
      fetchImpl: async (url) => {
        if (url === "https://secure.soundcloud.com/oauth/token") {
          return jsonResponse(200, {
            access_token: rotatedJwt,
            refresh_token: "rt_attached_2",
            expires_in: 3600,
          });
        }
        if (url.includes("/me")) {
          return jsonResponse(200, { id: 33, username: "updated", avatar_url: "" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    plugin.setSetting({
      key: "oauthRefreshToken",
      value: "oauth_refresh_token=rt_attached_1",
    });
    expect(store.get("refreshToken")).toBe("rt_attached_1");

    const acc = await plugin.account();
    expect(acc.name).toBe("updated");
    expect(store.get("token")).toBe(rotatedJwt);
    expect(store.get("refreshToken")).toBe("rt_attached_2");
  });

  test("signIn extracts both tokens from Cookie header prefix and Copy as cURL (bash/cmd)", async () => {
    const expSec = Math.floor((Date.now() + 3600 * 1000) / 1000);
    const accessJwt = makeJwt({ exp: expSec });

    const inputs = [
      `Cookie: my_oauth_token=wrong; oauth_token=${accessJwt}; oauth_refresh_token=rt_pad==`,
      `curl 'https://soundcloud.com/' -H 'accept: text/html' -b 'sc_anonymous_id=1; oauth_token=${accessJwt}; oauth_refresh_token=rt_pad=='`,
      `curl ^"https://soundcloud.com/^" -b ^"oauth_token=${accessJwt}; oauth_refresh_token=rt_pad==^"`,
      `fetch("https://soundcloud.com/", { "headers": { "cookie": "oauth_token=${accessJwt}; oauth_refresh_token=rt_pad==" } });`,
    ];

    for (const raw of inputs) {
      const { plugin, store } = await setupPlugin({
        storage: { clientId: "WebClientId123456789012345678901", clientIdAt: Date.now() },
        settings: { oauthToken: raw },
        fetchImpl: async (url) => {
          if (url.includes("/connect/session")) return jsonResponse(200, { ok: true });
          if (url.includes("/me")) {
            return jsonResponse(200, { id: 99, username: "curluser", avatar_url: "" });
          }
          throw new Error("unexpected url: " + url);
        },
      });

      const acc = await plugin.signIn();
      expect(acc.name).toBe("curluser");
      expect(store.get("token")).toBe(accessJwt);
      expect(store.get("refreshToken")).toBe("rt_pad==");
    }
  });

  test("signIn uses host.webSignIn with popup-free redirect auth URL and captures both tokens without btoa", async () => {
    const expSec = Math.floor((Date.now() + 3600 * 1000) / 1000);
    const accessJwt = makeJwt({ exp: expSec, client_id: "WebSignInClientId123456789012345" });
    const mobiCid = "MobiClientId12345678901234567890";
    let capturedOpts = null;

    const { plugin, store } = await setupPlugin({
      hideAtob: true,
      storage: { clientId: "WebClientId123456789012345678901", clientIdAt: Date.now() },
      webSignInImpl: async (opts) => {
        capturedOpts = opts;
        return {
          cookie: `sc_anonymous_id=abc; oauth_token=${accessJwt}; oauth_refresh_token=rt_from_webview`,
        };
      },
      fetchImpl: async (url, init) => {
        if (url === "https://m.soundcloud.com/signin") {
          return new Response(`{"clientId":"${mobiCid}"}`, { status: 200 });
        }
        if (url.includes("/me")) {
          expect(init.headers.Authorization).toBe("OAuth " + accessJwt);
          return jsonResponse(200, { id: 77, username: "webview_user", avatar_url: "" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const acc = await plugin.signIn();
    expect(acc).toEqual({ id: "77", name: "webview_user", imageUrl: "", page: "me" });
    const authUrl = new URL(capturedOpts.url);
    expect(authUrl.origin + authUrl.pathname).toBe("https://secure.soundcloud.com/web-auth");
    expect(authUrl.searchParams.get("client_id")).toBe(mobiCid);
    expect(authUrl.searchParams.get("app_id")).toBe("3152");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://m.soundcloud.com/signin/callback");
    expect(authUrl.searchParams.get("stand_alone")).toBe("true");
    const decodedState = JSON.parse(
      Buffer.from(authUrl.searchParams.get("state"), "base64").toString("utf8"),
    );
    expect(decodedState.origin).toBe("https://soundcloud.com");
    expect(decodedState.path).toBe("/discover");
    expect(decodedState.client_id).toBe(mobiCid);
    expect(capturedOpts.cookiesOf).toBe("https://soundcloud.com/n/api/refresh-token");
    expect(capturedOpts.until).toEqual(["oauth_token"]);
    expect(capturedOpts.userAgent).toContain("Edg/");
    expect(store.get("token")).toBe(accessJwt);
    expect(store.get("refreshToken")).toBe("rt_from_webview");
    expect(store.get("tokenExpiresAt")).toBe(expSec * 1000);
  });

  test("signIn throws setup error when settings are empty and host.webSignIn is unavailable", async () => {
    const { plugin } = await setupPlugin({
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    });

    let err = null;
    try {
      await plugin.signIn();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe("setup");
  });

  test("stream uses bundled hls-helper without invoking ffmpeg and reuses the helper across tracks", async () => {
    const spawned = [];
    let registerCalls = 0;

    const { plugin } = await setupPlugin({
      storage: { clientId: "WebClientId123456789012345678901", clientIdAt: Date.now() },
      spawnImpl: (cmd) => {
        spawned.push(cmd);
        if (cmd === "bin/hls-helper.exe") {
          let read = false;
          return {
            readLine: async () => {
              if (!read) {
                read = true;
                return '{"port":45678}';
              }
              return null;
            },
            wait: () => new Promise(() => {}),
            kill: () => {},
            closeStdin: () => {},
            errorOutput: () => "",
          };
        }
        throw new Error("not found: " + cmd);
      },
      fetchImpl: async (url, init) => {
        if (url.includes("/tracks/101")) {
          return jsonResponse(200, {
            id: 101,
            title: "Song A",
            track_authorization: "ta_101",
            media: {
              transcodings: [
                {
                  preset: "aac_160k",
                  url: "https://api-v2.soundcloud.com/media/101/hls",
                  format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
                },
              ],
            },
          });
        }
        if (url.includes("/media/101/hls")) {
          return jsonResponse(200, { url: "https://cf-hls-media.sndcdn.com/playlist/101.m3u8" });
        }
        if (url === "http://127.0.0.1:45678/register") {
          registerCalls += 1;
          const body = JSON.parse(init.body);
          expect(body.url).toBe("https://cf-hls-media.sndcdn.com/playlist/101.m3u8");
          return jsonResponse(200, {
            id: `stream_${registerCalls}`,
            type: "aac",
            url: `http://127.0.0.1:45678/stream/stream_${registerCalls}`,
          });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const s1 = await plugin.stream({ id: "101", quality: "high" });
    const s2 = await plugin.stream({ id: "101", quality: "high" });

    expect(s1).toEqual({
      url: "http://127.0.0.1:45678/stream/stream_1",
      type: "aac",
      quality: "high",
      bitRate: 160000,
    });
    expect(s2.url).toBe("http://127.0.0.1:45678/stream/stream_2");
    expect(registerCalls).toBe(2);
    // Helper was probed and spawned once, never invoking ffmpeg.
    expect(spawned).toEqual(["bin/hls-helper-windows-amd64.exe", "bin/hls-helper.exe"]);
  });

  test("stream throws setup error when bundled hls-helper is missing without spawning ffmpeg", async () => {
    const spawned = [];
    const { plugin } = await setupPlugin({
      storage: { clientId: "WebClientId123456789012345678901", clientIdAt: Date.now() },
      spawnImpl: (cmd) => {
        spawned.push(cmd);
        throw new Error("not found: " + cmd);
      },
      fetchImpl: async (url) => {
        if (url.includes("/tracks/202")) {
          return jsonResponse(200, {
            id: 202,
            title: "Song B",
            track_authorization: "ta_202",
            media: {
              transcodings: [
                {
                  preset: "aac_160k",
                  url: "https://api-v2.soundcloud.com/media/202/hls",
                  format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
                },
              ],
            },
          });
        }
        if (url.includes("/media/202/hls")) {
          return jsonResponse(200, { url: "https://cf-hls-media.sndcdn.com/playlist/202.m3u8" });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    let err = null;
    try {
      await plugin.stream({ id: "202", quality: "high" });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe("setup");
    expect(spawned).toEqual(["bin/hls-helper-windows-amd64.exe", "bin/hls-helper.exe"]);
  });

  // Regression: SoundCloud /users/:id/track_likes rejects numeric offsets > 0
  // with 400 (ChronoParams.Cursor) and requires following opaque next_href cursors.
  test("liked paginates with SoundCloud opaque next_href cursors instead of numeric offset", async () => {
    const validJwt = makeJwt({ exp: Math.floor((Date.now() + 3600 * 1000) / 1000) });
    const requestedUrls = [];

    const { plugin } = await setupPlugin({
      storage: {
        clientId: "WebClientId123456789012345678901",
        clientIdAt: Date.now(),
        token: validJwt,
      },
      fetchImpl: async (url) => {
        if (url.includes("/me?")) {
          return jsonResponse(200, { id: 42, username: "alice", avatar_url: "" });
        }
        if (url.includes("/users/42/track_likes")) {
          requestedUrls.push(url);
          const parsed = new URL(url);
          const cursor = parsed.searchParams.get("offset");
          if (cursor && /^\d+$/.test(cursor) && cursor !== "0") {
            return jsonResponse(400, {
              message: `ChronoParams.Cursor: invalid cursor format: ${cursor}`,
            });
          }
          if (!cursor) {
            return jsonResponse(200, {
              collection: [
                { track: { id: 1, title: "Song 1", duration: 1000, user: { id: 9, username: "a" } } },
                { track: { id: 2, title: "Song 2", duration: 1000, user: { id: 9, username: "a" } } },
              ],
              next_href:
                "https://api-v2.soundcloud.com/users/42/track_likes?offset=2025-12-27T21%3A42%3A37.486Z%2Cuser-track-likes%2C000-42-2&limit=20",
            });
          }
          return jsonResponse(200, {
            collection: [
              { track: { id: 3, title: "Song 3", duration: 1000, user: { id: 9, username: "a" } } },
            ],
            next_href: null,
          });
        }
        throw new Error("unexpected url: " + url);
      },
    });

    const page1 = await plugin.liked({ offset: 0 });
    expect(page1.tracks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(page1.more).toBe(true);

    const page2 = await plugin.liked({ offset: 2 });
    expect(page2.tracks.map((t) => t.id)).toEqual(["3"]);
    expect(page2.more).toBe(false);

    expect(new URL(requestedUrls[0]).searchParams.get("offset")).toBeNull();
    expect(new URL(requestedUrls[1]).searchParams.get("offset")).toContain(
      "2025-12-27T21:42:37.486Z",
    );
  });
});
