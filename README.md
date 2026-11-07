# Clip It — a Sharkord plugin

Press a hotkey (or a button in the voice controls) to clip the last N seconds
of a voice channel's audio and video, instant-replay style.

> Status: scaffold. The contract, settings, UI slot and hotkey are wired; the
> media pipeline is not implemented yet.

## How it will work

1. **Buffer** — the server half subscribes to the channel's producers with
   `ctx.voice.consume()` and keeps a rolling ring buffer of the last
   `clipSeconds` of RTP packets per stream. The `onRtp` callback only buffers;
   all real work happens at clip time.
2. **Encode** — on clip, the buffered packets are handed to ffmpeg (via an SDP
   built from the consumer's `rtpParameters`) and written to `ctx.dataPath`.
   [Sharkord/iptv](https://github.com/Sharkord/iptv) has a worked example of
   downloading and driving ffmpeg from a plugin.
3. **Serve** — an authenticated `ctx.http` route serves the stored clips, and
   a push notifies the channel that a clip was created.

## Layout

```
manifest.json              the plugin's identity, and the SDK version it targets
src/types.ts               the typed contract shared by both halves
src/server/index.ts        runs in the Sharkord server process
src/client/index.ts        declares which components render where
src/client/clip-controls.tsx   the voice-panel button + bindable hotkey
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

## Publishing

Bump `version` in `package.json`, set `GITHUB_TOKEN` in `.env`, then:

```bash
bun run publish
```

This builds, creates the GitHub release, and opens a PR against the
[Sharkord plugin registry](https://github.com/Sharkord/plugins).
