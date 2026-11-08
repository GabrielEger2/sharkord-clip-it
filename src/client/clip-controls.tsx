import {
  actions,
  createCallAction,
  useHotkey,
  useNotify,
  usePush,
  useStoreSelector,
} from "@sharkord/plugin-sdk/client";
import { IconButton } from "@sharkord/ui";
import { Clapperboard } from "lucide-react";
import { memo, useCallback, useState } from "react";
import type { TClip, TPlugin } from "../types";

const PLUGIN_ID = "clip-it";

const callAction = createCallAction<TPlugin>();

/**
 * The clip route needs the caller's auth, so the file is fetched through the
 * host and handed to the browser as a download, which is what lands it in the
 * user's downloads folder.
 */
const downloadClip = async (clip: TClip) => {
  const response = await actions.fetchPluginRoute(PLUGIN_ID, `/${clip.url}`);

  if (!response.ok) {
    throw new Error(`Fetching the clip failed: ${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = objectUrl;
  anchor.download = clip.fileName;
  anchor.click();

  URL.revokeObjectURL(objectUrl);
};

/**
 * Renders in the voice controls panel while the user is in a voice channel.
 * The button and the hotkey both capture "the last N seconds" of the call.
 */
const ClipControls = memo(() => {
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const currentVoiceChannelId = useStoreSelector(
    (state) => state.currentVoiceChannelId,
  );
  const ownUserId = useStoreSelector((state) => state.ownUserId);
  const users = useStoreSelector((state) => state.users);

  const onClip = useCallback(
    (clip: TClip) => {
      const author = users.find((user) => user.id === clip.userId);
      const media = clip.hasVideo ? "with the screen share" : "audio only";

      notify({
        title: "Clip created",
        body: `${author?.name ?? "Someone"} clipped the last ${clip.seconds}s (${media}).`,
      });

      if (clip.userId !== ownUserId) return;

      downloadClip(clip).catch((err) => {
        console.error("clip-it: downloading the clip failed", err);
      });
    },
    [users, ownUserId, notify],
  );

  usePush<TPlugin>(onClip);

  const makeClip = useCallback(async () => {
    if (!currentVoiceChannelId || busy) return;

    setBusy(true);

    try {
      await callAction("clip", { channelId: currentVoiceChannelId });
    } catch (err) {
      const body = err instanceof Error ? err.message : "Clipping failed.";

      notify({ title: "Clip failed", body });
    } finally {
      setBusy(false);
    }
  }, [currentVoiceChannelId, busy, notify]);

  useHotkey({ id: "clip", label: "Clip the last seconds" }, () => {
    makeClip().catch(() => {});
  });

  if (!currentVoiceChannelId) return null;

  return (
    <IconButton
      icon={Clapperboard}
      title="Clip It"
      variant="ghost"
      disabled={busy}
      onClick={makeClip}
    />
  );
});

export { ClipControls };
