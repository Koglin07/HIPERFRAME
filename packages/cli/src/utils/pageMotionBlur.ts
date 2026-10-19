import { CAPTURE_MOTION_BLUR_CANARY, PAGE_MOTION_BLUR_DEFAULT_GLOBAL } from "@hyperframes/core";
import { isCanaryEnabled } from "../telemetry/canary.js";

// WYSIWYG: no blur if the Studio preview could not show it; otherwise the canary decides.
export function renderPageMotionBlur(previewMotionBlur?: boolean): "default" | "off" | undefined {
  if (previewMotionBlur === false) return "off";
  return isCanaryEnabled(CAPTURE_MOTION_BLUR_CANARY) ? "default" : undefined;
}

export function previewMotionBlurPrelude(): string {
  return isCanaryEnabled(CAPTURE_MOTION_BLUR_CANARY)
    ? `window[${JSON.stringify(PAGE_MOTION_BLUR_DEFAULT_GLOBAL)}]=true;\n`
    : "";
}
