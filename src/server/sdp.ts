import type { RtpParameters } from "@sharkord/plugin-sdk";

// one SDP describing every replayed stream, each on its own loopback port.
// a single SDP matters: ffmpeg binds all of a file's ports when it opens the
// input, where separate -i inputs are opened (and bound) one at a time, so
// replaying to a later input's port hits nothing and raises ICMP errors

const isRtx = (mimeType: string) => /\/rtx$/i.test(mimeType);

const getMediaCodec = (rtpParameters: RtpParameters) => {
  const codec = rtpParameters.codecs.find((c) => !isRtx(c.mimeType));

  if (!codec) {
    throw new Error("The stream's rtpParameters carry no media codec");
  }

  return codec;
};

const buildMediaSection = (
  rtpParameters: RtpParameters,
  port: number,
): string[] => {
  const codec = getMediaCodec(rtpParameters);
  const [mediaKind, codecName] = codec.mimeType.split("/");
  const channels =
    mediaKind === "audio" && codec.channels ? `/${codec.channels}` : "";

  const fmtpEntries = Object.entries(codec.parameters ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );

  const lines = [
    `m=${mediaKind} ${port} RTP/AVP ${codec.payloadType}`,
    `a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}${channels}`,
  ];

  if (fmtpEntries.length > 0) {
    lines.push(`a=fmtp:${codec.payloadType} ${fmtpEntries.join(";")}`);
  }

  lines.push("a=recvonly");

  return lines;
};

const buildCombinedSdp = (
  streams: { rtpParameters: RtpParameters; port: number }[],
): string => {
  const lines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=sharkord-clip",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
  ];

  for (const stream of streams) {
    lines.push(...buildMediaSection(stream.rtpParameters, stream.port));
  }

  return `${lines.join("\n")}\n`;
};

const getStreamMediaKind = (
  rtpParameters: RtpParameters,
): "audio" | "video" => {
  const codec = getMediaCodec(rtpParameters);

  return codec.mimeType.toLowerCase().startsWith("video") ? "video" : "audio";
};

const getVideoCodecName = (rtpParameters: RtpParameters): string => {
  const codec = getMediaCodec(rtpParameters);
  const name = codec.mimeType.split("/")[1];

  return (name ?? "").toLowerCase();
};

export { buildCombinedSdp, getStreamMediaKind, getVideoCodecName };
