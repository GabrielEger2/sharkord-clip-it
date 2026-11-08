import type { PluginContext } from "@sharkord/plugin-sdk";
import fs from "fs/promises";
import path from "path";
import { getBinDir, getDownloadDir, getFfmpegBinaryPath } from "./paths";

// the ffmpeg download-and-run setup is lifted from Sharkord/iptv, which uses
// the same prebuilt binaries release
type TDownloadLogger = Pick<PluginContext["logger"], "log" | "error">;

const downloadPaths: {
  [key: string]: {
    ffmpeg: string;
  };
} = {
  linux_x64: {
    ffmpeg:
      "https://github.com/diogomartino/plugin-binaries/releases/latest/download/ffmpeg-linux-x64.tar.gz",
  },
  linux_arm64: {
    ffmpeg:
      "https://github.com/diogomartino/plugin-binaries/releases/latest/download/ffmpeg-linux-arm64.tar.gz",
  },
  win32_x64: {
    ffmpeg:
      "https://github.com/diogomartino/plugin-binaries/releases/latest/download/ffmpeg-win64.tar.gz",
  },
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
};

const ensureDir = async (dir: string, logger?: TDownloadLogger) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    logger?.error(`Failed to create directory ${dir}:`, err);
    throw err;
  }
};

const getPlatformArch = (): string => `${process.platform}_${process.arch}`;

const findFileRecursive = async (
  rootDir: string,
  fileName: string,
): Promise<string | null> => {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }

    if (entry.isDirectory()) {
      const nestedPath = await findFileRecursive(entryPath, fileName);

      if (nestedPath) {
        return nestedPath;
      }
    }
  }

  return null;
};

const extractArchive = async (
  archivePath: string,
  extractPath: string,
  logger: TDownloadLogger,
): Promise<void> => {
  await ensureDir(extractPath, logger);
  logger.log(`Extracting archive ${archivePath} to ${extractPath}`);

  const tarball = await Bun.file(archivePath).bytes();
  const archive = new Bun.Archive(tarball);
  const entryCount = await archive.extract(extractPath);

  logger.log(`Extracted ${entryCount} entries from ${archivePath}`);
};

const downloadFile = async (
  url: string,
  outputPath: string,
  logger: TDownloadLogger,
): Promise<void> => {
  await ensureDir(path.dirname(outputPath), logger);
  logger.log(`Starting download from ${url} to ${outputPath}`);

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error(`Download response has no body: ${url}`);
  }

  const totalBytesHeader = res.headers.get("content-length");
  const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : NaN;
  const hasTotalBytes = Number.isFinite(totalBytes) && totalBytes > 0;
  const file = await fs.open(outputPath, "w");
  const reader = res.body.getReader();

  let downloadedBytes = 0;
  let lastLoggedPercent = -1;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      await file.write(value);

      downloadedBytes += value.byteLength;

      if (hasTotalBytes) {
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);

        if (percent >= lastLoggedPercent + 10 || percent === 100) {
          logger.log(
            `Downloading ${path.basename(outputPath)}: ${percent}% (${downloadedBytes}/${totalBytes} bytes)`,
          );

          lastLoggedPercent = percent;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}

    await file.close();
  }

  logger.log(
    `Finished downloading ${path.basename(outputPath)}: ${downloadedBytes} bytes`,
  );
};

const makeExecutable = async (binaryPath: string): Promise<void> => {
  if (process.platform !== "win32") {
    await fs.chmod(binaryPath, 0o755);
  }
};

const downloadFFmpeg = async (logger: TDownloadLogger) => {
  const arch = getPlatformArch();
  const url = downloadPaths[arch]?.ffmpeg;

  if (!url) {
    throw new Error(`No ffmpeg download URL configured for platform: ${arch}`);
  }

  const binaryPath = getFfmpegBinaryPath();
  const binaryName = path.basename(binaryPath);

  logger.log(`Downloading ffmpeg for ${arch} from ${url}`);

  const urlFilename = path.basename(new URL(url).pathname);
  const extractedName = urlFilename.replace(/\.tar\.gz$/, "");
  const archivePath = path.join(getDownloadDir(), `ffmpeg_${arch}.tar.gz`);
  const extractPath = path.join(getDownloadDir(), `ffmpeg_extract_${arch}`);

  await ensureDir(getDownloadDir(), logger);
  await ensureDir(getBinDir(), logger);
  await fs.rm(extractPath, { recursive: true, force: true });

  await downloadFile(url, archivePath, logger);
  await extractArchive(archivePath, extractPath, logger);

  const extractedBinaryPath =
    (await findFileRecursive(extractPath, extractedName)) ??
    (await findFileRecursive(extractPath, binaryName));

  if (!extractedBinaryPath) {
    throw new Error(
      `Could not find ${extractedName} or ${binaryName} in extracted archive: ${archivePath}`,
    );
  }

  await fs.copyFile(extractedBinaryPath, binaryPath);
  await makeExecutable(binaryPath);
  await fs.rm(extractPath, { recursive: true, force: true });

  logger.log(`ffmpeg downloaded successfully to ${binaryPath}`);
};

const areRequiredBinariesPresent = async (): Promise<boolean> =>
  pathExists(getFfmpegBinaryPath());

const ensureRequiredBinaries = async (logger: TDownloadLogger) => {
  if (await areRequiredBinariesPresent()) {
    logger.log(`Using existing ffmpeg at ${getFfmpegBinaryPath()}`);

    return;
  }

  await downloadFFmpeg(logger);

  try {
    await fs.rm(getDownloadDir(), { recursive: true, force: true });
  } catch {
    // leftovers are retried into on the next download, not a problem
  }
};

export { areRequiredBinariesPresent, ensureRequiredBinaries, pathExists };
export type { TDownloadLogger };
