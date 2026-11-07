# Architecture

## Purpose

This plugin brings SoundCloud into MyGo Music. It covers two jobs:

- **Catalog and library** — home, charts, search, artist pages, album and
  playlist pages, the listener's stream, liked tracks, playlists and recently
  played.
- **Playback** — resolving SoundCloud's audio and handing the app an MP3 it can
  decode.

The scope is deliberately read-only. Liking, following, playlist editing,
comments, podcasts and remote playback are not implemented.

The plugin talks to SoundCloud's private web API (`api-v2.soundcloud.com`), not
the public developer API. There is no registered OAuth application. A listener's
own browser session is used instead, which is why signing in means pasting the
`oauth_token` cookie.

## Runtime model

A MyGo Music plugin is a folder with a `plugin.json` and one JavaScript entry
file. There is no build step and no package installation. The runtime provides:

- JavaScript standard library, timers, `fetch`, `URL`, `console`
- `host.storage` for JSON values that outlive the app
- `host.setting` for values the listener filled in
- `host.spawn` for programs named in the process permission
- `host.t` and `host.language` for translations

Two constraints shape the design:

1. **One file.** The app loads a single `main` file, so every module lives in
   `index.js`. Sections are separated by comment banners instead of imports.
2. **Call timeout.** Most exports must answer within 30 seconds. Sign-in is the
   exception at 5 minutes. Playback therefore resolves the media URL and starts
   ffmpeg quickly; it does not wait for the whole track.

Permissions in `plugin.json` are explicit:

- Network: `soundcloud.com`, `*.soundcloud.com`, `api-v2.soundcloud.com`,
  `api-auth.soundcloud.com`, `*.sndcdn.com`, `*.soundcloud.cloud`, `lrclib.net`
- Process: `ffmpeg`, plus the Homebrew and `/usr/local` paths

## Module map

`index.js` is organised in this order:

| Section | Responsibility |
| --- | --- |
| Constants and helpers | Endpoints, user agent, TTLs, `fail`, storage helpers, token parsing |
| HTTP | `request`, `api`, URL building, retry and error mapping |
| Client id | Scraping and caching SoundCloud's web client id |
| Session | `signIn`, `signOut`, `account`, `setSetting`, cached `/me` |
| Mapping | SoundCloud objects to `Track`, `Album`, `Artist`, `Playlist` |
| Track details | Shared raw-track cache used by playback and lyrics |
| Home and browse | Home sections, charts, following, My Page, recent |
| Search | Tracks, albums, artists, playlists, suggestions |
| Library | Playlists, playlist detail, album detail, artist detail, liked |
| History | Remote play history plus a local fallback |
| Lyrics | LRCLIB lookup and LRC generation |
| Playback | Transcoding selection, ffmpeg process management, `stream` |

The exported functions are the plugin's public API; everything else is private
to the file.

## Request pipeline

All API calls go through one wrapper:

```
api(path, { query, method, body, auth })
```

It performs five steps:

1. **Build the URL.** Absolute transcoding URLs are accepted as-is; relative
   paths are joined to `https://api-v2.soundcloud.com`. `client_id` and the
   caller's query parameters are appended.
2. **Attach identity.** `Authorization: OAuth <token>` is sent when a token is
   stored and the caller did not pass `auth: false`. Public calls opt out so a
   stale token cannot break browsing.
3. **Send.** `fetch` with a browser user agent and a SoundCloud referer.
4. **Classify the result.** `401`, `403`, `404`, `429` and other non-2xx answers
   become plugin errors with the right code.
5. **Return JSON**, or text when the body was not JSON.

### Client id lifecycle

SoundCloud's web client id is not documented. It is embedded in one of the
JavaScript assets that `soundcloud.com` loads.

- `clientIdValue` caches the id in memory and in `host.storage` for 24 hours.
- On a `401` the wrapper forces one rescrape and retries the request once.
- A second `401` means the session token is stale, not the client id.
- Scraping tries the home page, then `/discover`, then every `sndcdn` asset in
  reverse order. The first `client_id:"…"` match wins.

This is the most fragile part of the integration. SoundCloud has changed or
removed client ids before, and the plugin reports a clear error when it cannot
find one rather than failing silently.

### Error mapping

| Condition | Error code | Effect in the app |
| --- | --- | --- |
| No session where one is needed | `signIn` | Prompts the listener to sign in |
| Missing `oauth_token` setting | `setup` | Opens the plugin settings |
| Token rejected or expired | `signIn` | Prompts for a new token |
| Missing resource, blocked track, DRM-only track | `unavailable` | Shows the message, skips playback |
| Unknown page | `unavailable` | Shows the message |
| Missing ffmpeg | `setup` | Opens settings with an install hint |
| Rate limit or unexpected server answer | plain error | Shows the message |

## Authentication and session

Signing in is cookie-based:

1. The listener copies `oauth_token` from their browser and pastes it into the
   plugin setting.
2. `signIn` normalises the value. It accepts a bare token, `oauth_token=…`, or a
   whole Cookie header.
3. The token is validated with `POST
   https://api-auth.soundcloud.com/connect/session?client_id=…` and the body
   `{"session":{"access_token":"…"}}`.
4. On success the token is stored in `host.storage` and `/me` is fetched.
5. On failure the storage entry is removed and a `signIn` error is raised.

`setSetting` clears the stored token when `oauthToken` changes, so a new paste
always starts a new session. `account` returns `null` when there is no token or
when `/me` rejects it, which makes the app show itself as signed out.

The token is stored unencrypted in the plugin's data folder. It is sent only to
SoundCloud hosts. This matches the behaviour of other MyGo plugins that depend
on web sessions.

## Data mapping

SoundCloud's model differs from the app's in three places.

**Tracks have no album.** A track either carries a publisher album title or not.
The mapper therefore:

- uses the containing playlist as the album when a track is listed inside a
  playlist or album page;
- otherwise uses `publisher_metadata.album_title`, or the translated word
  "Single", and an album id of `track:<id>`. `album()` understands that id and
  returns a one-track album page, so clicking it never dead-ends.

**Artists are users.** `user` objects become `Artist`. SoundCloud has no
separate artist entity.

**Albums are playlists.** `/search/albums` and `is_album: true` playlists map to
`Album`. Album pages are read from `/playlists/{id}`.

Artwork URLs are normalised to `-t500x500` so the app does not download
thousands-of-pixels originals for a 40-pixel row.

### Playlist hydration

SoundCloud returns full objects only for the first few entries of a playlist;
the rest arrive as stubs such as `{id, kind, policy}`. Rendering those directly
produces rows with no title and no length. The plugin collects the missing ids
and resolves them through the batch endpoint `/tracks?ids=…`, fifty at a time,
then restores the original order. Entries that cannot be resolved are dropped
instead of shown empty. A 473-track playlist hydrates in about five seconds.

Playlist tracks still use the playlist as their album context, but the cover
shown in a row is the track's own artwork. The playlist cover is only a fallback
when the track has neither artwork nor an uploader avatar.

### Availability

A track is marked `unavailable` when any of these is true:

- `streamable` is `false`
- `policy` is present and not `ALLOW`
- the only transcodings are `cbc-encrypted-hls` or `ctr-encrypted-hls`

Those encrypted streams are Widevine/PlayReady SAMPLE-AES. They cannot be
decoded by ffmpeg or downloaded by yt-dlp. This is why some major-label tracks
show as unavailable while independent uploads play.

## Pages

**Home** is assembled from independent calls, each allowed to fail:

- signed in: `/stream`, `/me/play-history/tracks`, the listener's playlists,
  liked tracks
- always: trending charts

`Promise.allSettled` keeps a failing section from taking down the page.

**Charts** uses `/charts?kind=trending` and adds playlists from
`/mixed-selections`.

**Following** reads `/users/{me}/followings`.

**My Page** (`page: "me"`) reads the profile, own playlists, liked tracks and
uploaded tracks.

**Recently played** merges `me/play-history/tracks` with a local history
recorded by `played`. The local list survives when the remote endpoint changes
or the token is absent.

**Liked** reads `/users/{me}/track_likes`, which returns like objects whose
`track` field is the song.

**Playlists** merges own playlists (`users/{me}/playlists`, albums filtered out)
with liked playlists (`users/{me}/likes`, items with a `playlist`).

Pagination uses SoundCloud's `offset` where accepted and `next_href` to decide
whether a next page exists.

## Playback pipeline

```
stream({ id })
  -> GET /tracks/{id}
  -> choose transcoding
  -> GET transcoding.url?client_id=…&track_authorization=…
  -> signed playlist.m3u8
  -> ffmpeg -i <m3u8> -c:a libmp3lame -f mp3 -listen 1 127.0.0.1:<port>
  -> { url: "http://127.0.0.1:<port>/", type: "mp3" }
```

Transcoding choice:

1. plain `hls` with `aac_160k`
2. plain `hls` with `aac_96k`
3. any other plain `hls`
4. `progressive`, returned directly when present

Encrypted protocols are never selected. `progressive` is rare now but is kept
as a fast path because it needs no ffmpeg.

### Process management

- ffmpeg is looked up on the PATH, then `/opt/homebrew/bin`, then
  `/usr/local/bin`. A successful `-version` run proves it is usable.
- At most three ffmpeg processes are kept. Opening a fourth kills the oldest.
- Each process is killed after ten minutes, or when it exits on its own.
- The function waits for ffmpeg's `Input #0` line before returning the local
  URL. A port check would consume the single request ffmpeg answers.
- The port is random in `20000–60000`.

Measured on a 4-minute track: about 1 second to first audio, and ffmpeg reads
the HLS faster than real time, so seeking and caching are responsive.

### Caching

| Cache | Where | TTL |
| --- | --- | --- |
| Client id | Memory + storage | 24 hours |
| Raw track JSON | Memory | 5 minutes |
| Hydrated playlist tracks | Memory, in the raw track cache | 5 minutes |
| Signed HLS URL | Not cached | Resolved per playback |
| Lyrics | Memory | Session |
| Listening history | Storage | Last 50 tracks |
| `/me` | Memory | Session |

Signed media URLs are short-lived, so they are resolved when playback starts
rather than stored.

## Lyrics

SoundCloud has no lyrics API. The plugin:

1. Fetches the track's title, publisher metadata, uploader and duration.
2. Builds artist candidates from `publisher_metadata.artist`, the part before
   `" - "` in the title, the uploader, and the uploader with words such as
   "official", "VEVO" and "music" removed. This matters because many uploads
   name the channel where the artist belongs.
3. Removes featured-artist and "official video/audio" noise from the title.
4. Calls LRCLIB `/api/get` with each artist, title and duration.
5. Falls back to `/api/search` per artist and to a full-text query, then picks
   the result whose name holds the title, using length as a tiebreak.
6. Returns `syncedLyrics` as LRC. If only `plainLyrics` exists, it builds an LRC
   file with timestamps spread evenly across the track.

Failures return an empty object, so a missing lyric never blocks playback.

## Localisation

Every user-facing string is an English key passed through `host.t`. Translations
live in `locales/zh-CN.json`. `locales/en.json` mirrors the keys as a reference
for translators; MyGo Music deliberately skips English when loading locales,
because English text is the key itself.

## Security and privacy

- The token is a bearer credential. It is stored only in the plugin's data
  folder and sent only to `api-v2` and `api-auth` hosts.
- Public calls do not carry the token, which limits its exposure and keeps
  browsing alive if it expires.
- No request logs include the token.
- The plugin does not proxy audio through third parties. ffmpeg connects to
  SoundCloud's signed media hosts directly.
- No data leaves the machine except requests to SoundCloud and LRCLIB.

## Limitations

- **Private API.** Endpoints, the client id and media formats can change without
  notice.
- **DRM.** Encrypted HLS tracks cannot be played.
- **No write actions.** Likes, follows, playlist edits and comments are out of
  scope.
- **No podcasts or stations.**
- **Token lifetime.** An expired or revoked `oauth_token` requires a new paste.

## Testing

`scripts/smoke.js` exercises the public half without an account:

1. Scrape the client id from `soundcloud.com`.
2. Search tracks and assert results.
3. Find a track with plain HLS and resolve its playlist.
4. Decode two seconds with ffmpeg.
5. Query LRCLIB.

Run it with `bun run smoke`.

Manual checks cover the account half:

- Paste a token, sign in, confirm the account menu and My Page.
- Open Home, Liked, a playlist, an artist, an album and search results.
- Play an independent upload (plain HLS) and a major-label track (expect
  unavailable).
- Seek inside a track, then play a second track to confirm the process pool.
- Switch the app to Chinese and check translated titles and errors.

## Future work

The write half is a separate phase: `like`, `isLiked`, `followArtist`,
`savePlaylist`, `saveAlbum`, playlist create/rename/delete, add/remove tracks
and comments. The endpoints are known and use the same session, but they need
careful testing against a real account. A browser sign-in flow
(`host.webSignIn`) is also possible, but it crashes the Linux build, so pasting
the cookie remains the supported path.
