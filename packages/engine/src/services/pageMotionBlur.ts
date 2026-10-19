/**
 * Tells the page's capture motion blur what this render wants, before any of its scripts run.
 *
 * Off when the engine blurs (it would average frames that are already blurred) or when the
 * render must match a Studio preview that could not blur (`pageMotionBlur: "off"`). On by
 * default, for roots that did not opt in, with `pageMotionBlur: "default"`.
 */

import { PAGE_MOTION_BLUR_DEFAULT_GLOBAL, PAGE_MOTION_BLUR_OFF_GLOBAL } from "@hyperframes/core";
import type { Page } from "puppeteer-core";
import type { CaptureOptions } from "../types.js";

export async function installPageMotionBlur(
  page: Pick<Page, "evaluateOnNewDocument">,
  options: Pick<CaptureOptions, "motionBlur" | "pageMotionBlur">,
): Promise<void> {
  const off = options.motionBlur
    ? "engine-motion-blur"
    : options.pageMotionBlur === "off"
      ? "preview-unsupported"
      : null;
  const [name, value] = off
    ? [PAGE_MOTION_BLUR_OFF_GLOBAL, off]
    : options.pageMotionBlur === "default"
      ? [PAGE_MOTION_BLUR_DEFAULT_GLOBAL, true]
      : [null, null];
  if (!name) return;
  await page.evaluateOnNewDocument(
    (key: string, v: unknown) => {
      (window as unknown as Record<string, unknown>)[key] = v;
    },
    name,
    value,
  );
}
