#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 SoundGo contributors
//
// Live smoke test for the public half of the plugin. It needs network access
// and ffmpeg, but no SoundCloud account. Run it with `bun run smoke`.
//
// It checks the four things the plugin depends on: SoundCloud's client id can
// be found, the catalog answers, a track resolves to HLS, and ffmpeg decodes
// that HLS.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let failures = 0;

function pass(name, detail = "") {
  console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
}

function fail(name, error) {
  failures += 1;
  console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : error}`);
}

async function get(url, json = false) {
  const response = await fetch(url, {
    headers: { "user-agent": UA, accept: json ? "application/json" : "text/html" },
    redirect: "follow",
  });
  const text = await response.text();
  return { status: response.status, text, data: json ? JSON.parse(text) : null };
}

async function clientId() {
  const home = await get("https://soundcloud.com/");
  if (home.status !== 200) throw new Error(`soundcloud.com answered ${home.status}`);

  const scripts = [...home.text.matchAll(/<script[^>]+src="(https:\/\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((src) => src.includes("sndcdn"))
    .reverse();

  for (const src of scripts) {
    const asset = await get(src);
    const found = asset.text.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/);
    if (found) return found[1];
  }

  throw new Error("client id not found in any asset");
}

async function ffmpegPath() {
  for (const path of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    try {
      const proc = Bun.spawn([path, "-version"], { stdout: "ignore", stderr: "ignore" });
      if ((await proc.exited) === 0) return path;
    } catch {
      // Try the next place.
    }
  }
  return null;
}

const id = await clientId();
pass("client id", id);

const search = await get(
  `https://api-v2.soundcloud.com/search/tracks?q=lofi&limit=20&client_id=${id}`,
  true,
);
if (!search.data || !search.data.collection || !search.data.collection.length) {
  throw new Error("search returned nothing");
}
pass("search tracks", `${search.data.collection.length} results, first "${search.data.collection[0].title}"`);

const playable = search.data.collection.find((track) =>
  (track.media?.transcodings || []).some((item) => item.format?.protocol === "hls"),
);
if (!playable) throw new Error("no plain HLS track in the results");
pass("plain HLS track", `"${playable.title}" (${playable.id})`);

const transcoding = playable.media.transcodings.find(
  (item) => item.format?.protocol === "hls" && item.preset === "aac_160k",
) || playable.media.transcodings.find((item) => item.format?.protocol === "hls");

const mediaUrl = new URL(transcoding.url);
mediaUrl.searchParams.set("client_id", id);
if (playable.track_authorization) {
  mediaUrl.searchParams.set("track_authorization", playable.track_authorization);
}

const media = await get(mediaUrl.toString(), true);
if (!media.data?.url) throw new Error("no signed playlist URL");
pass("HLS playlist", media.data.url.slice(0, 72) + "...");

const ffmpeg = await ffmpegPath();
if (!ffmpeg) {
  fail("ffmpeg", "not found on PATH, /opt/homebrew/bin or /usr/local/bin");
} else {
  pass("ffmpeg", ffmpeg);
  const proc = Bun.spawn(
    [ffmpeg, "-hide_banner", "-v", "error", "-t", "2", "-i", media.data.url, "-f", "null", "-"],
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  if (code === 0) pass("ffmpeg decodes HLS", "2 seconds");
  else fail("ffmpeg decodes HLS", stderr.trim().split("\n").pop());
}

const lyrics = await get(
  `https://lrclib.net/api/search?track_name=${encodeURIComponent(playable.title)}&artist_name=${encodeURIComponent(playable.user?.username || "")}`,
  true,
);
if (Array.isArray(lyrics.data)) {
  pass("LRCLIB answers", `${lyrics.data.length} matches`);
} else {
  fail("LRCLIB answers", `status ${lyrics.status}`);
}

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
