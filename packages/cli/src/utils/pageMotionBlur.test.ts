import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetCanaryCacheForTests } from "../telemetry/canary.js";
import { previewMotionBlurPrelude, renderPageMotionBlur } from "./pageMotionBlur.js";

afterEach(() => {
  vi.unstubAllEnvs();
  __resetCanaryCacheForTests();
});

const canary = (value: string): void => {
  vi.stubEnv("HF_CANARY_CAPTURE_MOTION_BLUR", value);
  __resetCanaryCacheForTests();
};

describe("renderPageMotionBlur", () => {
  it("turns blur off when the Studio preview could not show it, canary or not", () => {
    canary("on");
    expect(renderPageMotionBlur(false)).toBe("off");
  });

  it("is on by default with the canary, opt-in only without it", () => {
    canary("on");
    expect(renderPageMotionBlur(true)).toBe("default");
    expect(renderPageMotionBlur()).toBe("default");
    canary("off");
    expect(renderPageMotionBlur(true)).toBeUndefined();
  });
});

describe("previewMotionBlurPrelude", () => {
  it("gives the preview the same default as the render", () => {
    canary("on");
    expect(previewMotionBlurPrelude()).toBe('window["__HF_PAGE_MOTION_BLUR_DEFAULT__"]=true;\n');
    canary("off");
    expect(previewMotionBlurPrelude()).toBe("");
  });
});
