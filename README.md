# SoundGo for MyGo Music

Plays SoundCloud in [MyGo Music](https://github.com/egoist/mygo-music), including the library of a personal account. It uses SoundCloud's private web API, is not affiliated with or endorsed by SoundCloud, and may stop working at any time.

## Install

Install in MyGo Music, or add this repository in **Settings > Plugins > +**:

```
https://github.com/satyawikananda/soundgo
```

Use the plugin ZIP attached to a release for manual installation, not GitHub's source ZIP. The minimum supported MyGo Music version is listed in `plugin.json` as `minAppVersion`.

SoundGo plays through [ffmpeg](https://ffmpeg.org). Install it first:

```bash
brew install ffmpeg
```

In Settings > Plugins, allow SoundGo to start programs. It starts only `ffmpeg`, from the PATH, `/opt/homebrew/bin` or `/usr/local/bin`.

## Signing in

1. Sign in at [soundcloud.com](https://soundcloud.com) in a browser.
2. Open the developer tools, then **Application > Cookies > https://soundcloud.com**.
3. Copy the value of the `oauth_token` cookie.
4. Paste it in Settings > Plugins > SoundGo, then click **Sign In**.

The token is kept unencrypted in the plugin's data on this machine and is sent only to SoundCloud. Signing out forgets it. To end the session on SoundCloud's side, sign out in the browser.

The public catalog, search and playback work without signing in.

## What works

- Signed out: Home, charts, search (tracks, albums, artists, playlists), artist pages, album and playlist pages, playback, lyrics.
- Signed in: your stream, recently played, your playlists, liked tracks, liked playlists, your own tracks, and a personal Home and My Page.
- Not available: liking, following, editing playlists, comments and podcasts.

## How it plays

SoundCloud serves most audio as HLS, which the app cannot decode. The plugin resolves the HLS playlist with the account's session, then ffmpeg turns it into MP3 on the fly and serves it on `127.0.0.1` for the app. Startup takes about a second.

Some tracks, mostly major-label releases, are encrypted with Widevine or PlayReady. No plugin can play those; they are shown as unavailable.

## Lyrics

SoundCloud has no lyrics. The plugin asks [LRCLIB](https://lrclib.net) by title, artist and length, and shows a synced lyric when it finds one. A plain lyric is spread over the track's length.

## Privacy

The plugin talks to `soundcloud.com`, `api-v2.soundcloud.com`, `api-auth.soundcloud.com`, `*.sndcdn.com`, `*.soundcloud.cloud` and `lrclib.net`. It reads SoundCloud's public pages to find the current web client id, keeps that id, the session token, cached track metadata and the local listening history in its data folder, and sends nothing anywhere else.

## Credits

- [MyGo Music](https://github.com/egoist/mygo-music) by egoist: the plugin runtime, its demo plugin, and the data model this plugin follows.
- [YouTube Music for MyGo Music](https://github.com/egoist/mygo-music-youtube-music) by egoist: the pattern of serving ffmpeg's MP3 on `127.0.0.1`, rewritten here for SoundCloud's HLS.
- [LRCLIB](https://lrclib.net) for lyrics.

SoundGo is an independent plugin. It is not affiliated with or endorsed by SoundCloud, MyGo Music, or the projects above.

## License

AGPL-3.0. See [LICENSE](LICENSE).
