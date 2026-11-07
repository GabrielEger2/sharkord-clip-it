import {
  type PluginContext,
  type TUpgradeInfo,
  type UnloadPluginContext,
  type UpgradePluginContext,
} from "@sharkord/plugin-sdk";
import type { TClip, TPlugin } from "../types";

const onLoad = async (ctx: PluginContext<TPlugin>) => {
  ctx.logger.log("Clip It loaded");

  const settings = await ctx.settings.register([
    {
      key: "clipSeconds",
      name: "Clip length",
      description: "How many seconds of media a clip captures.",
      type: "number",
      defaultValue: 30,
    },
    {
      key: "maxStoredClips",
      name: "Stored clips",
      description: "Oldest clips are deleted past this count.",
      type: "number",
      defaultValue: 50,
    },
  ] as const);

  ctx.ui.enable();

  // TODO(buffer): keep a rolling buffer of the voice channel's media.
  // `ctx.voice.consume({ channelId, userId, kind, onRtp })` delivers raw RTP
  // packets (~every 20ms per audio producer); keep the last `clipSeconds`
  // worth per producer in a ring buffer and do nothing else in `onRtp`.
  // Subscribe/unsubscribe on `voice:producer_added` / removed events.

  // TODO(encode): on clip, hand the buffered packets to ffmpeg (an SDP built
  // from the consumer's `rtpParameters`) and write the file to
  // `ctx.dataPath`, pruning past `maxStoredClips`. See Sharkord/iptv for a
  // worked ffmpeg download-and-run setup inside a plugin.

  // TODO(serve): register a `ctx.http` route (auth: true) serving clips from
  // `ctx.dataPath`, which is what `TClip.url` points at.

  ctx.actions.register({
    name: "clip",
    executes: async (invoker, payload): Promise<TClip> => {
      const seconds = settings.get("clipSeconds");

      ctx.logger.log(
        `clip requested by user ${invoker.userId} in channel ${payload.channelId} (${seconds}s)`,
      );

      throw new Error("Not implemented yet: media buffering is next.");
    },
  });
};

const onUnload = (ctx: UnloadPluginContext) => {
  ctx.logger.log("Clip It unloaded");
};

const onUpgrade = (ctx: UpgradePluginContext, info: TUpgradeInfo) => {
  ctx.logger.log(`Upgraded from ${info.previousVersion} to ${info.version}`);
};

export { onLoad, onUnload, onUpgrade };
