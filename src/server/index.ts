import {
  type PluginContext,
  type TUpgradeInfo,
  type UnloadPluginContext,
  type UpgradePluginContext,
} from "@sharkord/plugin-sdk";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { TClip, TPlugin } from "../types";
import { assertBinariesReady, startBinaryBootstrap } from "./binaries";
import { pruneUserClips, saveClip } from "./clips";
import { encodeClip, getClipMime } from "./encode";
import { getUserClipsDir, setDataDir } from "./paths";
import { snapshotChannel, startRecorder, stopRecorder } from "./recorder";

// `<userId>/<fileName>` as TClip.url carries it; anything else is not a clip
// path, which is also what keeps the route from serving outside the clips dir
const CLIP_URL_PATTERN = /\/clips\/(\d+)\/([0-9a-f-]+\.(?:webm|mkv))$/;

// one encode per channel at a time: a second press while one runs would fight
// over the same buffered window anyway
const busyChannels = new Set<number>();

const onLoad = async (ctx: PluginContext<TPlugin>) => {
  ctx.logger.log("Clip It loaded");

  setDataDir(ctx.dataPath);
  startBinaryBootstrap(ctx.logger);

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
      name: "Stored clips per user",
      description: "A user's oldest clips are deleted past this count.",
      type: "number",
      defaultValue: 50,
    },
  ] as const);

  ctx.ui.enable();

  await startRecorder(ctx, () => settings.get("clipSeconds"));

  ctx.http.get(
    "/clips/*",
    async (req, res) => {
      const match = CLIP_URL_PATTERN.exec(req.url?.split("?")[0] ?? "");

      if (!match) {
        res.writeHead(404);
        res.end();

        return;
      }

      const filePath = path.join(getUserClipsDir(Number(match[1])), match[2]!);
      const stat = await fs.stat(filePath).catch(() => null);

      if (!stat || !stat.isFile()) {
        res.writeHead(404);
        res.end();

        return;
      }

      res.writeHead(200, {
        "Content-Type": getClipMime(filePath),
        "Content-Length": stat.size,
      });

      await new Promise<void>((resolve) => {
        const stream = createReadStream(filePath);

        stream.on("close", resolve);
        stream.on("error", () => {
          res.destroy();
          resolve();
        });
        stream.pipe(res);
      });
    },
    { auth: true },
  );

  ctx.actions.register({
    name: "clip",
    executes: async (invoker, payload): Promise<TClip> => {
      const seconds = Math.max(1, settings.get("clipSeconds"));
      const { channelId } = payload;

      await assertBinariesReady();

      // getState throws when the channel has no live voice runtime
      const state = ctx.voice.getState(channelId);
      const isInChannel = state.users.some(
        (user) => user.userId === invoker.userId,
      );

      if (!isInChannel) {
        throw new Error("You can only clip a voice channel you are in.");
      }

      if (busyChannels.has(channelId)) {
        throw new Error("A clip of this channel is already being made.");
      }

      busyChannels.add(channelId);

      try {
        const streams = snapshotChannel(channelId, seconds);

        if (streams.length === 0) {
          throw new Error(
            "Nothing is buffered yet. Someone has to speak or share first.",
          );
        }

        ctx.logger.log(
          `clip requested by user ${invoker.userId} in channel ${channelId} (${seconds}s, ${streams.length} streams)`,
        );

        const id = crypto.randomUUID();
        const result = await encodeClip({
          streams,
          seconds,
          outBasePath: path.join(getUserClipsDir(invoker.userId), id),
          logger: ctx.logger,
        });

        const clip: TClip = {
          id,
          userId: invoker.userId,
          channelId,
          seconds,
          createdAt: Date.now(),
          url: `clips/${invoker.userId}/${result.fileName}`,
          fileName: result.fileName,
          hasVideo: result.hasVideo,
        };

        await saveClip(ctx, clip);
        await pruneUserClips(ctx, invoker.userId, settings.get("maxStoredClips"));

        ctx.push.toVoiceChannel(channelId, clip);

        return clip;
      } finally {
        busyChannels.delete(channelId);
      }
    },
  });
};

const onUnload = (ctx: UnloadPluginContext) => {
  stopRecorder();
  ctx.logger.log("Clip It unloaded");
};

const onUpgrade = (ctx: UpgradePluginContext, info: TUpgradeInfo) => {
  ctx.logger.log(`Upgraded from ${info.previousVersion} to ${info.version}`);
};

export { onLoad, onUnload, onUpgrade };
