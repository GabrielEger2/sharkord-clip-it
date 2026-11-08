import type { PluginContext } from "@sharkord/plugin-sdk";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import path from "node:path";
import { getFfmpegBinaryPath, getWorkDir } from "./paths";
import type { TStreamSnapshot } from "./recorder";
import { buildStreamSdp, getStreamMediaKind, getVideoCodecName } from "./sdp";

// buffered packets are replayed faster than real time; 8x turns a 30s clip
// into under 4s of encoding without flooding the loopback sockets
const REPLAY_SPEED = 8;

// ffmpeg has to be listening on the SDP ports before the first packet lands
const FFMPEG_STARTUP_MS = 1000;

// everything is already sent, so a stuck ffmpeg is a bug and not patience
const FFMPEG_EXIT_TIMEOUT_MS = 30_000;

const QUIET = ["-hide_banner", "-nostats", "-loglevel", "level+warning"];

type TLogger = PluginContext["logger"];

type TEncodeOptions = {
  streams: TStreamSnapshot[];
  seconds: number;
  /** output path without extension; the container picks it */
  outBasePath: string;
  logger: TLogger;
};

type TEncodeResult = {
  filePath: string;
  fileName: string;
  hasVideo: boolean;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * An even port for RTP so port+1 is free for the RTCP ffmpeg also binds. Both
 * are bound here to prove the pair is free, then released for ffmpeg; the gap
 * between release and ffmpeg's bind is a race nothing else should win locally.
 */
const allocateRtpPort = (used: Set<number>): Promise<number> =>
  new Promise((resolve, reject) => {
    let attempts = 0;

    const tryOnce = () => {
      attempts += 1;

      if (attempts > 50) {
        reject(new Error("Could not find a free local RTP port pair"));

        return;
      }

      const rtp = dgram.createSocket("udp4");

      rtp.once("error", tryOnce);
      rtp.bind(0, "127.0.0.1", () => {
        const port = rtp.address().port;

        if (port % 2 !== 0 || used.has(port)) {
          rtp.close(tryOnce);

          return;
        }

        const rtcp = dgram.createSocket("udp4");

        rtcp.once("error", () => rtp.close(tryOnce));
        rtcp.bind(port + 1, "127.0.0.1", () => {
          used.add(port);
          rtcp.close(() => rtp.close(() => resolve(port)));
        });
      });
    };

    tryOnce();
  });

const buildFfmpegArgs = (options: {
  sdpPaths: string[];
  offsets: number[];
  audioInputs: number[];
  videoInput: number | null;
  container: string;
  seconds: number;
  outPath: string;
}): string[] => {
  const args = [...QUIET];

  for (let i = 0; i < options.sdpPaths.length; i += 1) {
    args.push(
      "-protocol_whitelist",
      "file,udp,rtp",
      "-analyzeduration",
      "1000000",
      "-probesize",
      "1048576",
      "-itsoffset",
      options.offsets[i]!.toFixed(3),
      "-i",
      options.sdpPaths[i]!,
    );
  }

  if (options.audioInputs.length === 1) {
    args.push(
      "-map",
      `${options.audioInputs[0]}:a:0`,
      // opus DTX leaves holes where someone was silent; async resampling
      // fills them so the clip does not time-compress
      "-af",
      "aresample=async=1",
    );
  } else if (options.audioInputs.length > 1) {
    const resampled = options.audioInputs.map(
      (input, j) => `[${input}:a:0]aresample=async=1[a${j}]`,
    );
    const mixInputs = options.audioInputs.map((_, j) => `[a${j}]`).join("");
    const mix = `${mixInputs}amix=inputs=${options.audioInputs.length}:duration=longest:normalize=0[aout]`;

    args.push("-filter_complex", [...resampled, mix].join(";"), "-map", "[aout]");
  }

  if (options.audioInputs.length > 0) {
    args.push("-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  }

  if (options.videoInput !== null) {
    args.push("-map", `${options.videoInput}:v:0`, "-c:v", "copy");
  }

  args.push(
    "-t",
    String(options.seconds + 2),
    "-f",
    options.container,
    "-y",
    options.outPath,
  );

  return args;
};

/** replays every stream's packets onto its port, paced by arrival time */
const replayPackets = async (
  streams: TStreamSnapshot[],
  ports: number[],
): Promise<void> => {
  const sockets = streams.map(() => dgram.createSocket("udp4"));

  const timeline = streams
    .flatMap((stream, i) =>
      stream.packets.map((packet) => ({ at: packet.at, data: packet.data, i })),
    )
    .sort((a, b) => a.at - b.at);

  try {
    const firstAt = timeline[0]!.at;
    const startedReal = Date.now();

    for (const packet of timeline) {
      const target = (packet.at - firstAt) / REPLAY_SPEED;
      const elapsed = Date.now() - startedReal;

      if (target > elapsed + 2) {
        await sleep(target - elapsed);
      }

      sockets[packet.i]!.send(packet.data, ports[packet.i]!, "127.0.0.1");
    }

    // let the socket queues drain before ffmpeg is told to stop
    await sleep(500);
  } finally {
    for (const socket of sockets) socket.close();
  }
};

const encodeClip = async (options: TEncodeOptions): Promise<TEncodeResult> => {
  const { streams, seconds, outBasePath, logger } = options;

  if (streams.length === 0) {
    throw new Error("There is no buffered media to clip yet");
  }

  const audioInputs: number[] = [];

  let videoInput: number | null = null;

  for (let i = 0; i < streams.length; i += 1) {
    if (getStreamMediaKind(streams[i]!.rtpParameters) === "video") {
      // one video per clip: the first live screen share wins
      if (videoInput === null) videoInput = i;
    } else {
      audioInputs.push(i);
    }
  }

  let container = "webm";

  if (videoInput !== null) {
    const codecName = getVideoCodecName(streams[videoInput]!.rtpParameters);

    // webm only holds vp8/vp9; an h264 screen share goes into matroska
    if (codecName === "h264") container = "matroska";
  }

  const extension = container === "webm" ? "webm" : "mkv";
  const outPath = `${outBasePath}.${extension}`;

  const workDir = getWorkDir();

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const usedPorts = new Set<number>();
  const ports: number[] = [];

  for (let i = 0; i < streams.length; i += 1) {
    ports.push(await allocateRtpPort(usedPorts));
  }

  const runId = path.basename(outBasePath);
  const sdpPaths: string[] = [];

  for (let i = 0; i < streams.length; i += 1) {
    const sdpPath = path.join(workDir, `${runId}-${i}.sdp`);

    await fs.writeFile(sdpPath, buildStreamSdp(streams[i]!.rtpParameters, ports[i]!));
    sdpPaths.push(sdpPath);
  }

  // streams started buffering at different moments; offsetting each input by
  // its first packet keeps the speakers and the screen aligned
  const firstAts = streams.map((stream) => stream.packets[0]!.at);
  const minFirstAt = Math.min(...firstAts);
  const offsets = firstAts.map((at) => (at - minFirstAt) / 1000);

  const args = buildFfmpegArgs({
    sdpPaths,
    offsets,
    audioInputs,
    videoInput,
    container,
    seconds,
    outPath,
  });

  logger.debug("Starting ffmpeg:", getFfmpegBinaryPath(), args.join(" "));

  const ffmpeg = spawn(getFfmpegBinaryPath(), args, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  ffmpeg.on("error", (err) => logger.error("[ffmpeg]", err));
  // this runs in the server process: an unhandled EPIPE on stdin after ffmpeg
  // exits early must never escape as an uncaught exception
  ffmpeg.stdin.on("error", () => {});

  const stderrTail: string[] = [];

  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();

      if (!trimmed) continue;

      stderrTail.push(trimmed);

      if (stderrTail.length > 20) stderrTail.shift();

      if (/\[(error|fatal|panic)\]/.test(trimmed)) {
        logger.error("[ffmpeg]", trimmed);
      } else {
        logger.debug("[ffmpeg]", trimmed);
      }
    }
  });

  const exited = new Promise<number | null>((resolve) => {
    ffmpeg.on("close", (code) => resolve(code));
  });

  try {
    await sleep(FFMPEG_STARTUP_MS);
    await replayPackets(streams, ports);

    // 'q' makes ffmpeg flush and finalize the file instead of waiting for
    // more packets that will never come
    try {
      ffmpeg.stdin.write("q");
      ffmpeg.stdin.end();
    } catch {
      // ffmpeg already exited, the close handler has the code
    }

    const code = await Promise.race([
      exited,
      sleep(FFMPEG_EXIT_TIMEOUT_MS).then(() => "timeout" as const),
    ]);

    if (code === "timeout") {
      ffmpeg.kill("SIGKILL");
      throw new Error("ffmpeg did not finish writing the clip in time");
    }
  } finally {
    for (const sdpPath of sdpPaths) {
      fs.rm(sdpPath, { force: true }).catch(() => {});
    }
  }

  const stat = await fs.stat(outPath).catch(() => null);

  if (!stat || stat.size === 0) {
    await fs.rm(outPath, { force: true }).catch(() => {});
    throw new Error(
      `ffmpeg produced no clip: ${stderrTail.slice(-5).join(" | ") || "no output"}`,
    );
  }

  return {
    filePath: outPath,
    fileName: path.basename(outPath),
    hasVideo: videoInput !== null,
  };
};

const getClipMime = (fileName: string): string =>
  fileName.endsWith(".webm") ? "video/webm" : "video/x-matroska";

export { encodeClip, getClipMime };
export type { TEncodeResult };
