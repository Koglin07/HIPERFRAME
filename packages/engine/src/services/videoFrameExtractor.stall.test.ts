import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG_PATH_ENV, getFfmpegBinary } from "../utils/ffmpegBinaries.js";
import { runFfmpeg } from "../utils/runFfmpeg.js";
import { extractVideoFramesRange } from "./videoFrameExtractor.js";

describe.skipIf(process.platform === "win32")("extraction ffmpeg time limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-extract-stall-"));
  const previousFfmpeg = process.env[FFMPEG_PATH_ENV];
  let clip = "";

  // `-re` reads the input at its own rate, so frames arrive steadily for the clip's length. ffmpeg's first
  // progress line can take 1.5 s on a busy Mac, so the steady run's limit leaves room for that.
  const shim = (name: string, body: string) => {
    const path = join(dir, `${name}.sh`);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const extractThrough = async (ffmpeg: string, id: string, limitMs: number) => {
    process.env[FFMPEG_PATH_ENV] = ffmpeg;
    try {
      return await extractVideoFramesRange(
        clip,
        id,
        0,
        6,
        { fps: 10, outputDir: join(dir, "out") },
        undefined,
        { ffmpegProcessTimeout: limitMs },
      );
    } finally {
      if (previousFfmpeg === undefined) delete process.env[FFMPEG_PATH_ENV];
      else process.env[FFMPEG_PATH_ENV] = previousFfmpeg;
    }
  };

  beforeAll(async () => {
    clip = join(dir, "clip.mp4");
    const made = await runFfmpeg([
      ...["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=32x32:d=6:r=10"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip],
    ]);
    expect(made.success, made.stderr).toBe(true);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finishes a run that takes longer than the limit while frames keep coming", async () => {
    const slow = shim("slow", `exec "${getFfmpegBinary()}" -re "$@"`);
    const started = Date.now();
    const frames = await extractThrough(slow, "slow", 3_000);
    expect(Date.now() - started).toBeGreaterThan(3_000);
    expect(frames.totalFrames).toBe(60);
  }, 30_000);

  it("stops a run that writes no frame for the limit, as a timeout", async () => {
    const stuck = shim("stuck", "exec sleep 30");
    await expect(extractThrough(stuck, "stuck", 500)).rejects.toMatchObject({
      kind: "ffmpeg_timeout",
      retryable: true,
    });
  }, 30_000);
});
