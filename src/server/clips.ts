import type { PluginContext } from "@sharkord/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import type { TClip, TPlugin } from "../types";
import { getUserClipsDir } from "./paths";

// keys order oldest first because the timestamp is zero padded, which is what
// lets pruning read a user's clips back in creation order
const clipKey = (userId: number, createdAt: number, id: string) =>
  `clip:${userId}:${String(createdAt).padStart(14, "0")}:${id}`;

const userClipsPrefix = (userId: number) => `clip:${userId}:`;

const saveClip = async (ctx: PluginContext<TPlugin>, clip: TClip) => {
  await ctx.storage.set(clipKey(clip.userId, clip.createdAt, clip.id), clip);
};

const pruneUserClips = async (
  ctx: PluginContext<TPlugin>,
  userId: number,
  maxStored: number,
) => {
  const entries = await ctx.storage.list({
    prefix: userClipsPrefix(userId),
    limit: 1000,
  });

  const excess = entries.length - Math.max(1, maxStored);

  if (excess <= 0) return;

  for (const entry of entries.slice(0, excess)) {
    const clip = entry.value as TClip;
    const filePath = path.join(getUserClipsDir(userId), clip.fileName);

    await fs.rm(filePath, { force: true }).catch(() => {});
    await ctx.storage.delete(entry.key);
  }
};

export { pruneUserClips, saveClip };
