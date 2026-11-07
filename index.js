// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 SoundGo contributors
//
// SoundCloud for MyGo Music: the listener's stream, likes, playlists, search,
// artist pages, charts, lyrics and audio, played from a personal account.
//
// Signing in takes the oauth_token cookie of a browser session, pasted into the
// plugin's settings. The public catalog works without it.
//
// SoundCloud serves audio as HLS, which the app cannot decode, so ffmpeg turns
// it into MP3 on the fly and serves it on 127.0.0.1. Tracks whose only streams
// are Widevine/PlayReady encrypted cannot be played and are marked unavailable.
//
// Everything the app shows is English text passed through host.t, which answers
// the translation in locales/zh-CN.json when the listener reads Chinese.

const API = "https://api-v2.soundcloud.com";
const AUTH = "https://api-auth.soundcloud.com";
const SITE = "https://soundcloud.com";
const LRCLIB = "https://lrclib.net";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const PAGE = 20;
const CLIENT_ID_TTL = 24 * 60 * 60 * 1000;
const TRACK_TTL = 5 * 60 * 1000;
const MEDIA_TTL = 30 * 60 * 1000;
const HISTORY_MAX = 50;

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

function requireToken() {
  if (!token()) throw fail("signIn", t("Sign in with your oauth_token first"));
}

// A pasted value can be the token itself, `oauth_token=...`, or a full Cookie
// header copied from the developer tools.
function readToken(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (/^OAuth\s+/i.test(value)) value = value.replace(/^OAuth\s+/i, "").trim();
  if (value.includes("=") || value.includes(";")) {
    for (const part of value.split(";")) {
      const at = part.indexOf("=");
      if (at < 0) continue;
      if (part.slice(0, at).trim() === "oauth_token")
        return part.slice(at + 1).trim();
    }
  }
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
  let refreshClientId = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const clientId = await clientIdValue(refreshClientId);
    const headers = {};
    if (options.auth !== false && token())
      headers.Authorization = "OAuth " + token();
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);

    const response = await request(apiUrl(path, clientId, query), {
      method: options.method || "GET",
      headers,
      body,
    });

    if (response.status === 401 && attempt === 0) {
      // Either the client id or the token is stale. A fresh client id tells
      // them apart: with a good one, a second 401 is the token.
      refreshClientId = true;
      continue;
    }

    if (response.status === 401) {
      if (token()) {
        host.storage.remove("token");
        meCache = null;
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

  const found = await scrapeClientId();
  clientIdCache = found;
  host.storage.set("clientId", found);
  host.storage.set("clientIdAt", Date.now());
  return found;
}

async function scrapeClientId() {
  const pages = [SITE + "/", SITE + "/discover"];

  for (const page of pages) {
    let html = "";
    try {
      const response = await request(page, {
        headers: { accept: "text/html" },
      });
      if (response.status !== 200) continue;
      html = response.text;
    } catch {
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
        const found = asset.text.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/);
        if (found) return found[1];
      } catch {
        // Another asset may have it.
      }
    }
  }

  throw new Error(t("Could not find SoundCloud's client id: try again later"));
}

// ---------------------------------------------------------------------------
// Session

let meCache = null;

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

export async function signIn() {
  const pasted = readToken(host.setting("oauthToken"));
  if (!pasted)
    throw fail(
      "setup",
      t("Paste your oauth_token in the plugin settings, then sign in"),
    );

  let accepted = false;
  for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
    const clientId = await clientIdValue(attempt > 0);
    const response = await request(
      `${AUTH}/connect/session?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: { access_token: pasted } }),
      },
    );
    accepted = response.status === 200;
  }

  if (!accepted) {
    throw fail("signIn", t("SoundCloud rejected that oauth_token"));
  }

  host.storage.set("token", pasted);
  meCache = null;

  try {
    const me = await meNow();
    return { id: me.id, name: me.name, imageUrl: me.imageUrl, page: "me" };
  } catch {
    host.storage.remove("token");
    meCache = null;
    throw fail("signIn", t("SoundCloud rejected that oauth_token"));
  }
}

export function signOut() {
  host.storage.remove("token");
  meCache = null;
}

export async function account() {
  if (!token()) return null;
  try {
    const me = await meNow();
    return { id: me.id, name: me.name, imageUrl: me.imageUrl, page: "me" };
  } catch {
    return null;
  }
}

export function setSetting({ key }) {
  // A new token replaces the old session; signing in validates the new one.
  if (key === "oauthToken") {
    host.storage.remove("token");
    meCache = null;
  }
}

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

  if (token()) {
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
  if (!token()) return [];
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
  const response = await api(`/users/${me.id}/track_likes`, {
    query: { limit: PAGE, offset, linked_partitioning: 1 },
  });
  const tracks = (response.collection || [])
    .map((item) => toTrack(item.track))
    .filter(Boolean);
  return { tracks, more: hasMore(response, tracks.length) };
}

// ---------------------------------------------------------------------------
// Listening history

export async function recent() {
  const local = load("history", []);
  let remote = [];

  if (token()) {
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
    headers: { "user-agent": "mygo-soundcloud/0.1.0 (MyGo Music plugin)" },
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

const processes = [];
const servingAtMost = 3;
const servedWithin = 10 * 60 * 1000;
const foundPrograms = {};

function stopWaiting() {
  while (processes.length >= servingAtMost) processes.shift().kill();
}

async function program(name, versionFlag) {
  if (foundPrograms[name]) return foundPrograms[name];

  const places = [name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  for (const path of places) {
    try {
      const proc = host.spawn(path, [versionFlag]);
      proc.closeStdin();
      while ((await proc.readLine()) !== null) {
        // Drain it.
      }
      if ((await proc.wait()) === 0) {
        foundPrograms[name] = path;
        return path;
      }
    } catch (error) {
      if (/allowed/.test(error.message)) {
        throw fail(
          "setup",
          t("Allow SoundCloud to start programs in its settings"),
        );
      }
    }
  }

  return null;
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

async function serve(playlist, kbps) {
  const ffmpeg = await program("ffmpeg", "-version");
  if (!ffmpeg) {
    throw fail(
      "setup",
      t(
        "SoundCloud plays through ffmpeg: install it with Homebrew, or so that it is on the PATH",
      ),
    );
  }

  stopWaiting();
  const port = 20000 + Math.floor(Math.random() * 40000);
  const proc = host.spawn(ffmpeg, [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-rw_timeout",
    "15000000",
    "-i",
    playlist,
    "-vn",
    "-c:a",
    "libmp3lame",
    "-b:a",
    `${kbps}k`,
    "-id3v2_version",
    "0",
    "-write_xing",
    "0",
    "-f",
    "mp3",
    "-listen",
    "1",
    `http://127.0.0.1:${port}/`,
  ]);
  proc.closeStdin();

  let stopped = false;
  processes.push(proc);
  const timer = setTimeout(() => proc.kill(), servedWithin);

  proc.wait().then(() => {
    stopped = true;
    clearTimeout(timer);
    const at = processes.indexOf(proc);
    if (at >= 0) processes.splice(at, 1);
  });

  const until = Date.now() + 15000;
  while (!proc.errorOutput().includes("Input #0")) {
    if (stopped) {
      const said = proc.errorOutput().trim().split("\n").pop() || "";
      throw new Error(`${t("The audio did not start")}: ${said}`);
    }
    if (Date.now() > until) {
      proc.kill();
      throw new Error(t("The audio did not start in time"));
    }
    await sleep(30);
  }

  await sleep(100);
  return `http://127.0.0.1:${port}/`;
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

  const kbps = quality === "standard" ? 128 : 192;
  const url = await serve(media, kbps);

  return {
    url,
    type: "mp3",
    quality: quality === "standard" ? "standard" : "high",
    bitRate: kbps * 1000,
  };
}
