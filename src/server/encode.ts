import type { PluginContext } from "@sharkord/plugin-sdk";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import path from "node:path";
import { getFfmpegBinaryPath, getWorkDir } from "./paths";
import type { TStreamSnapshot } from "./recorder";
import { buildCombinedSdp, getStreamMediaKind, getVideoCodecName } from "./sdp";

// buffered packets are replayed faster than real time; 8x turns a 30s clip
// into under 4s of encoding without flooding the loopback sockets
const REPLAY_SPEED = 8;

// ffmpeg has to be listening on the SDP ports before the first packet lands
const FFMPEG_STARTUP_MS = 1000;

// everything is already sent, so a stuck ffmpeg is a bug and not patience
const FFMPEG_EXIT_TIMEOUT_MS = 30_000;

const MIN_STREAM_PACKETS = 10;

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
  sdpPath: string;
  audioCount: number;
  hasVideo: boolean;
  container: string;
  seconds: number;
  outPath: string;
}): string[] => {
  const args = [
    ...QUIET,
    "-protocol_whitelist",
    "file,udp,rtp",
    // the probe has to span at least one keyframe interval (2s, forced by the
    // recorder) or vp8/vp9 dimensions stay unknown and the muxer refuses the
    // stream. stream time, so at replay speed this is well under a second
    "-analyzeduration",
    "5000000",
    "-probesize",
    "10485760",
    "-i",
    options.sdpPath,
  ];

  if (options.audioCount === 1) {
    args.push(
      "-map",
      "0:a:0",
      // opus DTX leaves holes where someone was silent; async resampling
      // fills them so the clip does not time-compress
      "-af",
      "aresample=async=1",
    );
  } else if (options.audioCount > 1) {
    const resampled = Array.from(
      { length: options.audioCount },
      (_, j) => `[0:a:${j}]aresample=async=1[a${j}]`,
    );
    const mixInputs = Array.from(
      { length: options.audioCount },
      (_, j) => `[a${j}]`,
    ).join("");
    const mix = `${mixInputs}amix=inputs=${options.audioCount}:duration=longest:normalize=0[aout]`;

    args.push("-filter_complex", [...resampled, mix].join(";"), "-map", "[aout]");
  }

  if (options.audioCount > 0) {
    args.push("-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  }

  if (options.hasVideo) {
    args.push("-map", "0:v:0", "-c:v", "copy");
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

/**
 * a send racing ffmpeg's bind raises ICMP "port unreachable" back on these
 * sockets as an async error event. this runs inside the server process, so
 * an unhandled one would take the whole host down, never just the clip
 */
const openReplaySockets = (count: number, logger: TLogger) =>
  Array.from({ length: count }, () => {
    const socket = dgram.createSocket("udp4");

    socket.on("error", (err) => logger.debug("[replay socket]", err.message));

    return socket;
  });

const closeSockets = (sockets: dgram.Socket[]) => {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {}
  }
};

/** replays every stream's packets onto its port, paced by arrival time */
const replayPackets = async (
  streams: TStreamSnapshot[],
  sockets: dgram.Socket[],
  ports: number[],
): Promise<void> => {
  const timeline = streams
    .flatMap((stream, i) =>
      stream.packets.map((packet) => ({ at: packet.at, data: packet.data, i })),
    )
    .sort((a, b) => a.at - b.at);

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
};

const encodeClip = async (options: TEncodeOptions): Promise<TEncodeResult> => {
  const { seconds, outBasePath, logger } = options;

  const streams = options.streams.filter((stream) => {
    if (stream.packets.length >= MIN_STREAM_PACKETS) return true;

    logger.debug(
      `Dropping a ${stream.kind} stream of user ${stream.userId} with only ${stream.packets.length} buffered packets`,
    );

    return false;
  });

  if (streams.length === 0) {
    throw new Error("There is no buffered media to clip yet");
  }

  let audioCount = 0;
  let videoStream: TStreamSnapshot | null = null;

  for (const stream of streams) {
    if (getStreamMediaKind(stream.rtpParameters) === "video") {
      // one video per clip: the first live screen share wins
      if (!videoStream) videoStream = stream;
    } else {
      audioCount += 1;
    }
  }

  // a second screen share has no slot in the clip, so it is not replayed
  const replayed = streams.filter(
    (stream) =>
      getStreamMediaKind(stream.rtpParameters) === "audio" ||
      stream === videoStream,
  );

  let container = "webm";

  if (videoStream) {
    const codecName = getVideoCodecName(videoStream.rtpParameters);

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

  for (let i = 0; i < replayed.length; i += 1) {
    ports.push(await allocateRtpPort(usedPorts));
  }

  const runId = path.basename(outBasePath);
  const sdpPath = path.join(workDir, `${runId}.sdp`);

  await fs.writeFile(
    sdpPath,
    buildCombinedSdp(
      replayed.map((stream, i) => ({
        rtpParameters: stream.rtpParameters,
        port: ports[i]!,
      })),
    ),
  );

  const args = buildFfmpegArgs({
    sdpPath,
    audioCount,
    hasVideo: videoStream !== null,
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

  const sockets = openReplaySockets(replayed.length, logger);

  try {
    await sleep(FFMPEG_STARTUP_MS);
    await replayPackets(replayed, sockets, ports);

    // 'q' makes ffmpeg flush and finalize the file instead of waiting for
    // more packets that will never come
    try {
      ffmpeg.stdin.write("q");
      ffmpeg.stdin.end();
    } catch {
      // ffmpeg already exited, the close handler has the code
    }

    // ffmpeg only checks for the 'q' between packets, and with the replay
    // over it sits ~10s in a blocking read first. resending the last packet
    // unblocks the read; the demuxer drops it as a duplicate sequence number
    let done = false;

    exited.then(() => {
      done = true;
    });

    const deadline = Date.now() + FFMPEG_EXIT_TIMEOUT_MS;

    while (!done && Date.now() < deadline) {
      for (let i = 0; i < replayed.length; i += 1) {
        const last = replayed[i]!.packets[replayed[i]!.packets.length - 1]!;

        sockets[i]!.send(last.data, ports[i]!, "127.0.0.1");
      }

      await sleep(250);
    }

    if (!done) {
      ffmpeg.kill("SIGKILL");
      throw new Error("ffmpeg did not finish writing the clip in time");
    }
  } finally {
    closeSockets(sockets);
    fs.rm(sdpPath, { force: true }).catch(() => {});
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
    hasVideo: videoStream !== null,
  };
};

const getClipMime = (fileName: string): string =>
  fileName.endsWith(".webm") ? "video/webm" : "video/x-matroska";

export { encodeClip, getClipMime };
export type { TEncodeResult };
