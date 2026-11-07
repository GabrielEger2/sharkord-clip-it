import {
  createCallAction,
  useHotkey,
  usePush,
  useStoreSelector,
} from "@sharkord/plugin-sdk/client";
import { IconButton } from "@sharkord/ui";
import { Clapperboard } from "lucide-react";
import { memo, useCallback, useState } from "react";
import type { TClip, TPlugin } from "../types";

const callAction = createCallAction<TPlugin>();

/**
 * Renders in the voice controls panel while the user is in a voice channel.
 * The button and the hotkey both capture "the last N seconds" of the call.
 */
const ClipControls = memo(() => {
  const [busy, setBusy] = useState(false);
  const currentVoiceChannelId = useStoreSelector(
    (state) => state.currentVoiceChannelId,
  );

  // TODO(ui): surface the created clip (toast/notification + link) instead of
  // only logging it. `usePush` receives every clip anyone in the channel makes.
  usePush<TPlugin>((clip: TClip) => {
    console.log("clip created", clip.url);
  });

  const makeClip = useCallback(async () => {
    if (!currentVoiceChannelId || busy) return;

    setBusy(true);

    try {
      await callAction("clip", { channelId: currentVoiceChannelId });
    } catch {
      // not implemented on the server yet
    } finally {
      setBusy(false);
    }
  }, [currentVoiceChannelId, busy]);

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
