// end-to-end smoke test for the clip-it encode pipeline, no Sharkord needed:
// the system ffmpeg streams real RTP (two opus voices + one VP8 "screen"),
// a dgram socket captures it the way recorder.ts does, and the captured
// packets go through the plugin's own encodeClip.
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import path from "node:path";
import type { RtpParameters } from "@sharkord/plugin-sdk";
import { encodeClip } from "../src/server/encode";
import { setDataDir } from "../src/server/paths";
import type { TStreamSnapshot } from "../src/server/recorder";

const DATA_DIR = path.join(import.meta.dir, "..", ".smoke-data");
const CAPTURE_SECONDS = 8;
const CLIP_SECONDS = 6;

const logger = {
  log: (...a: unknown[]) => console.log("[log]", ...a),
  debug: (...a: unknown[]) => console.log("[dbg]", ...a),
  error: (...a: unknown[]) => console.error("[err]", ...a),
};

const findSystemFfmpeg = async (name: string): Promise<string> => {
  const proc = Bun.spawnSync(["where.exe", name]);
  const out = proc.stdout.toString().trim().split(/\r?\n/)[0];

  if (!out) throw new Error(`${name} not found on PATH`);

  return out;
};

type TCapturedPacket = { at: number; data: Buffer };

const openCapture = (): Promise<{
  port: number;
  packets: TCapturedPacket[];
  close: () => void;
}> =>
  new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const packets: TCapturedPacket[] = [];

    socket.on("message", (msg) => {
      packets.push({ at: Date.now(), data: Buffer.from(msg) });
    });
    socket.bind(0, "127.0.0.1", () => {
      resolve({
        port: socket.address().port,
        packets,
        close: () => socket.close(),
      });
    });
  });

const senderArgs = {
  audio: (freq: number, pt: number, ssrc: number, port: number) => [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000`,
    "-t", String(CAPTURE_SECONDS),
    "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "2",
    "-payload_type", String(pt), "-ssrc", String(ssrc),
    "-f", "rtp", `rtp://127.0.0.1:${port}`,
  ],
  video: (pt: number, ssrc: number, port: number) => [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15",
    "-t", String(CAPTURE_SECONDS),
    "-c:v", "libvpx", "-b:v", "800k", "-deadline", "realtime", "-cpu-used", "8",
    "-g", "30",
    "-payload_type", String(pt), "-ssrc", String(ssrc),
    "-f", "rtp", `rtp://127.0.0.1:${port}?pkt_size=1200`,
  ],
};

const runSender = (ffmpeg: string, args: string[]): Promise<number | null> =>
  new Promise((resolve) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "inherit"] });

    proc.on("error", (err) => {
      console.error("sender failed to start", err);
      resolve(null);
    });
    proc.on("close", resolve);
  });

const audioRtpParameters = (pt: number, ssrc: number): RtpParameters =>
  ({
    codecs: [
      {
        mimeType: "audio/opus",
        payloadType: pt,
        clockRate: 48000,
        channels: 2,
        parameters: {},
      },
    ],
    encodings: [{ ssrc }],
  }) as RtpParameters;

const videoRtpParameters = (pt: number, ssrc: number): RtpParameters =>
  ({
    codecs: [
      {
        mimeType: "video/VP8",
        payloadType: pt,
        clockRate: 90000,
        parameters: {},
      },
    ],
    encodings: [{ ssrc }],
  }) as RtpParameters;

const ffmpeg = await findSystemFfmpeg("ffmpeg");
const ffprobe = await findSystemFfmpeg("ffprobe");

console.log("using system ffmpeg:", ffmpeg);

// encode.ts resolves its binary from the plugin data dir, so plant it there
setDataDir(DATA_DIR);
await fs.rm(DATA_DIR, { recursive: true, force: true });
await fs.mkdir(path.join(DATA_DIR, "bin"), { recursive: true });
await fs.copyFile(ffmpeg, path.join(DATA_DIR, "bin", "ffmpeg.exe"));

const capA = await openCapture();
const capB = await openCapture();
const capV = await openCapture();

console.log(`capturing ${CAPTURE_SECONDS}s of RTP on ports`, capA.port, capB.port, capV.port);

await Promise.all([
  runSender(ffmpeg, senderArgs.audio(440, 100, 1111, capA.port)),
  runSender(ffmpeg, senderArgs.audio(880, 100, 2222, capB.port)),
  runSender(ffmpeg, senderArgs.video(101, 3333, capV.port)),
]);

capA.close();
capB.close();
capV.close();

console.log(
  `captured packets: audioA=${capA.packets.length} audioB=${capB.packets.length} video=${capV.packets.length}`,
);

if (!capA.packets.length || !capB.packets.length || !capV.packets.length) {
  throw new Error("a capture came back empty, senders did not stream");
}

const windowStart = Date.now() - CLIP_SECONDS * 1000;
const cut = (packets: TCapturedPacket[]) =>
  packets.filter((p) => p.at >= windowStart);

const streams: TStreamSnapshot[] = [
  { userId: 1, kind: "audio" as never, rtpParameters: audioRtpParameters(100, 1111), packets: cut(capA.packets) },
  { userId: 2, kind: "audio" as never, rtpParameters: audioRtpParameters(100, 2222), packets: cut(capB.packets) },
  { userId: 1, kind: "screen" as never, rtpParameters: videoRtpParameters(101, 3333), packets: cut(capV.packets) },
];

console.log("encoding clip...");

const started = Date.now();
const result = await encodeClip({
  streams,
  seconds: CLIP_SECONDS,
  outBasePath: path.join(DATA_DIR, "clips", "1", "smoke-test"),
  logger,
});

console.log(`encode took ${Date.now() - started}ms ->`, result);

const probe = Bun.spawnSync([
  ffprobe, "-v", "error",
  "-show_entries", "format=duration,size",
  "-show_entries", "stream=codec_name,codec_type",
  "-of", "json", result.filePath,
]);

console.log("ffprobe:", probe.stdout.toString());

if (probe.exitCode !== 0) {
  console.error(probe.stderr.toString());
  throw new Error("ffprobe could not read the clip");
}

const parsed = JSON.parse(probe.stdout.toString());
const codecs = (parsed.streams as { codec_type: string; codec_name: string }[]) ?? [];
const hasOpus = codecs.some((s) => s.codec_type === "audio" && s.codec_name === "opus");
const hasVp8 = codecs.some((s) => s.codec_type === "video" && s.codec_name === "vp8");
const duration = Number(parsed.format?.duration ?? 0);

console.log({ hasOpus, hasVp8, duration });

if (!hasOpus || !hasVp8) throw new Error("the clip is missing a stream");
if (duration < CLIP_SECONDS - 2) throw new Error(`clip too short: ${duration}s`);

console.log("SMOKE TEST PASSED");
