# Clip It — a Sharkord plugin

Press a hotkey (or a button in the voice controls) to clip the last N seconds
of a voice channel's audio and screen share, instant-replay style. The clip is
saved per user on the server and downloaded straight into the clipping user's
downloads folder.

## How it works

1. **Buffer** — the server half subscribes to every `audio`, `screen` and
   `screen_audio` producer in live voice channels with `ctx.voice.consume()`
   and keeps a rolling ring buffer of the last `clipSeconds` of RTP packets
   per stream. While a screen share is buffered, a keyframe is requested every
   2 seconds so any point of the buffer is decodable. Camera video is not
   buffered.
2. **Encode** — on clip, each buffered stream gets an SDP file and a loopback
   UDP port, and the packets are replayed (paced, 8x real time) into a single
   ffmpeg run: every voice is mixed into one opus track (`amix`), and the
   screen share, when someone is sharing, is stream-copied without a
   transcode. VP8/VP9 clips land in `.webm`, H264 in `.mkv`. ffmpeg itself is
   downloaded on first load into `dataPath/bin`, the same setup as
   [Sharkord/iptv](https://github.com/Sharkord/iptv).
3. **Serve** — files are stored under `dataPath/clips/<userId>/` and served by
   an authenticated `/clips/*` route. The clip is pushed to everyone in the
   channel; the clipping user's client fetches it through
   `fetchPluginRoute` and hands it to the browser as a download. A user's
   oldest clips are pruned past `maxStoredClips`.

## Layout

```
manifest.json              the plugin's identity, and the SDK version it targets
src/types.ts               the typed contract shared by both halves
src/server/index.ts        settings, clip action, http route, wiring
src/server/recorder.ts     rolling RTP ring buffers per producer
src/server/sdp.ts          SDP files ffmpeg reads the replayed streams from
src/server/encode.ts       port allocation, packet replay, the ffmpeg run
src/server/clips.ts        clip metadata and per-user pruning
src/server/paths.ts        where binaries, clips and work files live
src/server/downloads.ts    ffmpeg download (from Sharkord/iptv)
src/server/binaries.ts     ffmpeg bootstrap state
src/client/index.ts        declares which components render where
src/client/clip-controls.tsx   the voice-panel button, hotkey, notify + download
```

## Developing

The SDK and builder are not on npm. This clones Sharkord and the plugin
builder into `.repos/` and `bun link`s them:

```bash
bun run setup
```

Point `SHARKORD_PLUGINS_PATH` in `.env` at your server's plugins folder (see
`.env.example`), then:

```bash
bun run build
```

Enable plugins in the server settings, then enable this one. Restart the
server to pick up a rebuild.

The encode pipeline can be exercised without a Sharkord server: with an
ffmpeg on your PATH,

```bash
bun run smoke
```

streams real RTP (two opus voices and a VP8 "screen share") to itself,
captures it the way the recorder does, and runs it through `encodeClip`,
asserting the resulting file holds both streams.

## Publishing

Bump `version` in `package.json`, set `GITHUB_TOKEN` in `.env`, then:

```bash
bun run publish
```

This builds, creates the GitHub release, and opens a PR against the
[Sharkord plugin registry](https://github.com/Sharkord/plugins).

## Known limits

- ffmpeg drops copied screen share video until the first buffered keyframe,
  so a clip's video can start up to 2 seconds (the forced keyframe interval)
  after its audio.
- Camera (`video`) producers are not clipped, only screen shares.
- Stream alignment uses packet arrival times, so cross-stream sync is within
  network jitter rather than sample exact.
