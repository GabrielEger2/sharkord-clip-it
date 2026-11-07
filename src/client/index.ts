import { PluginSlot } from "@sharkord/plugin-sdk";
import type { TPluginComponentsMapBySlotId } from "@sharkord/plugin-sdk/client";
import { ClipControls } from "./clip-controls";

const components: TPluginComponentsMapBySlotId = {
  [PluginSlot.VOICE_CONTROLS]: [ClipControls],
};

export { components };
