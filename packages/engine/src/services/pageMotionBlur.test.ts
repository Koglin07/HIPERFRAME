import { describe, expect, it, vi } from "vitest";
import { PAGE_MOTION_BLUR_DEFAULT_GLOBAL, PAGE_MOTION_BLUR_OFF_GLOBAL } from "@hyperframes/core";
import { installPageMotionBlur } from "./pageMotionBlur";

const fakePage = () => ({ evaluateOnNewDocument: vi.fn(async () => ({ identifier: "1" })) });

describe("installPageMotionBlur", () => {
  it("tells the page to stand down when the engine blurs, even if blur is on by default", async () => {
    const page = fakePage();
    await installPageMotionBlur(page, {
      motionBlur: { samplesPerFrame: 16 },
      pageMotionBlur: "default",
    });
    expect(page.evaluateOnNewDocument).toHaveBeenCalledTimes(1);
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith(
      expect.any(Function),
      PAGE_MOTION_BLUR_OFF_GLOBAL,
      "engine-motion-blur",
    );
  });

  it("turns the page off when the Studio preview could not blur", async () => {
    const page = fakePage();
    await installPageMotionBlur(page, { pageMotionBlur: "off" });
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith(
      expect.any(Function),
      PAGE_MOTION_BLUR_OFF_GLOBAL,
      "preview-unsupported",
    );
  });

  it("turns blur on by default when asked", async () => {
    const page = fakePage();
    await installPageMotionBlur(page, { pageMotionBlur: "default" });
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith(
      expect.any(Function),
      PAGE_MOTION_BLUR_DEFAULT_GLOBAL,
      true,
    );
  });

  it("leaves the page alone otherwise", async () => {
    const page = fakePage();
    await installPageMotionBlur(page, {});
    expect(page.evaluateOnNewDocument).not.toHaveBeenCalled();
  });
});
