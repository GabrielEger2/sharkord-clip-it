import type {
  PluginContext,
  RtpParameters,
  TConsumeOptions,
  TVoiceConsumerHandle,
} from "@sharkord/plugin-sdk";
import type { TPlugin } from "../types";

// the sdk types `kind` with the StreamKind enum but does not re-export the
// enum itself, so the values are mirrored here as plain strings
type TStreamKind = TConsumeOptions["kind"];

const BUFFERED_KINDS = ["audio", "screen", "screen_audio"];

const isScreenVideo = (kind: TStreamKind) => (kind as string) === "screen";

type TBufferedPacket = {
  /** wall clock arrival, what the clip window is cut against */
  at: number;
  data: Buffer;
};

type TStreamBuffer = {
  channelId: number;
  userId: number;
  kind: TStreamKind;
  producerId: string;
  rtpParameters: RtpParameters;
  packets: TBufferedPacket[];
  handle: TVoiceConsumerHandle;
  keyframeTimer: ReturnType<typeof setInterval> | null;
};

/** what the encoder receives: one stream's buffered window, already cut */
type TStreamSnapshot = {
  userId: number;
  kind: TStreamKind;
  rtpParameters: RtpParameters;
  packets: TBufferedPacket[];
};

// without regular keyframes a copied screen share only becomes decodable at
// whatever random point the sharer's encoder refreshed, which can be the
// whole clip away
const KEYFRAME_INTERVAL_MS = 2000;

// buffered past the configured window so a clip taken mid-prune is never short
const PRUNE_SLACK_MS = 3000;

const buffers = new Map<string, TStreamBuffer>();

let getMaxSeconds: () => number = () => 30;

const bufferKey = (channelId: number, producerId: string) =>
  `${channelId}:${producerId}`;

const pruneBuffer = (stream: TStreamBuffer) => {
  const cutoff = Date.now() - getMaxSeconds() * 1000 - PRUNE_SLACK_MS;

  while (stream.packets.length > 0 && stream.packets[0]!.at < cutoff) {
    stream.packets.shift();
  }
};

const detachStream = (key: string) => {
  const stream = buffers.get(key);

  if (!stream) return;

  if (stream.keyframeTimer) clearInterval(stream.keyframeTimer);

  buffers.delete(key);
  stream.handle.close();
};

const attachProducer = async (
  ctx: PluginContext<TPlugin>,
  channelId: number,
  userId: number,
  kind: TStreamKind,
  producerId: string,
) => {
  if (!BUFFERED_KINDS.includes(kind)) return;

  const key = bufferKey(channelId, producerId);

  if (buffers.has(key)) return;

  const packets: TBufferedPacket[] = [];

  let stream: TStreamBuffer | null = null;

  try {
    const handle = await ctx.voice.consume({
      channelId,
      userId,
      kind,
      onRtp: (packet) => {
        packets.push({ at: Date.now(), data: packet });

        if (stream) pruneBuffer(stream);
      },
    });

    // the initial sweep and a producer_added event can race past the guard
    // above; the second consumer of the same producer is redundant
    if (buffers.has(key)) {
      handle.close();

      return;
    }

    stream = {
      channelId,
      userId,
      kind,
      producerId,
      rtpParameters: handle.rtpParameters,
      packets,
      handle,
      keyframeTimer: null,
    };

    if (isScreenVideo(kind)) {
      handle.requestKeyFrame().catch(() => {});

      stream.keyframeTimer = setInterval(() => {
        handle.requestKeyFrame().catch(() => {
          // the producer is gone, the removed event tears this down
        });
      }, KEYFRAME_INTERVAL_MS);
    }

    buffers.set(key, stream);
  } catch (err) {
    ctx.logger.error(
      `Failed to start buffering ${kind} of user ${userId} in channel ${channelId}`,
      err,
    );
  }
};

const attachChannel = async (ctx: PluginContext<TPlugin>, channelId: number) => {
  let producers;

  try {
    producers = ctx.voice.getProducers(channelId);
  } catch {
    // no live voice runtime in this channel
    return;
  }

  for (const producer of producers) {
    await attachProducer(
      ctx,
      channelId,
      producer.userId,
      producer.kind,
      producer.producerId,
    );
  }
};

const startRecorder = async (
  ctx: PluginContext<TPlugin>,
  maxSeconds: () => number,
) => {
  getMaxSeconds = maxSeconds;

  ctx.events.on("voice:producer_added", (payload) => {
    attachProducer(
      ctx,
      payload.channelId,
      payload.userId,
      payload.kind,
      payload.producerId,
    ).catch((err) => ctx.logger.error("Failed to attach producer", err));
  });

  ctx.events.on("voice:producer_removed", (payload) => {
    detachStream(bufferKey(payload.channelId, payload.producerId));
  });

  ctx.events.on("voice:runtime_closed", (payload) => {
    for (const [key, stream] of Array.from(buffers)) {
      if (stream.channelId === payload.channelId) detachStream(key);
    }
  });

  // whoever was already producing when the plugin loaded
  const channels = await ctx.channels.list();

  for (const channel of channels) {
    await attachChannel(ctx, channel.id);
  }
};

const stopRecorder = () => {
  for (const key of Array.from(buffers.keys())) {
    detachStream(key);
  }
};

/** the last `seconds` of every buffered stream in the channel, cut to window */
const snapshotChannel = (
  channelId: number,
  seconds: number,
): TStreamSnapshot[] => {
  const windowStart = Date.now() - seconds * 1000;
  const snapshots: TStreamSnapshot[] = [];

  for (const stream of buffers.values()) {
    if (stream.channelId !== channelId) continue;

    const packets = stream.packets.filter((packet) => packet.at >= windowStart);

    if (packets.length === 0) continue;

    snapshots.push({
      userId: stream.userId,
      kind: stream.kind,
      rtpParameters: stream.rtpParameters,
      packets,
    });
  }

  return snapshots;
};

export { snapshotChannel, startRecorder, stopRecorder };
export type { TBufferedPacket, TStreamSnapshot };
