import path from "path";

// the plugin folder is deleted and rewritten on every update, so everything
// that has to survive (the ffmpeg binary, the clips) lives under dataPath
let dataDir = "";

const setDataDir = (value: string): void => {
  dataDir = value;
};

const getBinDir = (): string => path.join(dataDir, "bin");

const getDownloadDir = (): string => path.join(dataDir, "downloads");

const getFfmpegBinaryPath = (): string =>
  path.join(getBinDir(), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const getClipsDir = (): string => path.join(dataDir, "clips");

const getUserClipsDir = (userId: number): string =>
  path.join(getClipsDir(), String(userId));

// sdp files and half-written outputs, safe to wipe at any time
const getWorkDir = (): string => path.join(dataDir, "work");

export {
  getBinDir,
  getClipsDir,
  getDownloadDir,
  getFfmpegBinaryPath,
  getUserClipsDir,
  getWorkDir,
  setDataDir,
};
