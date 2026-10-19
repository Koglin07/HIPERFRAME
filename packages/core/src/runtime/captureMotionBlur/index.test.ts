import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CaptureMotionBlurHost,
  initCaptureMotionBlur,
  paintCaptureMotionBlur,
  resetCaptureMotionBlurForTests,
} from ".";

type Win = Window & {
  __HF_PAGE_MOTION_BLUR_OFF__?: unknown;
  __HF_PAGE_MOTION_BLUR_DEFAULT__?: unknown;
  __hfMotionBlur?: {
    report: () => {
      state: string;
      reason: string | null;
      shutterDeg: number;
      moverNames: string[];
    };
  };
  __hf_page_composite_pending?: boolean;
  __hf_page_composite_resolve?: () => boolean;
};
const win = window as Win;

// Every 2D context (page canvas or offscreen) is this recording fake.
function fakeContext() {
  return {
    reset: vi.fn(),
    drawElementImage: vi.fn(),
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  };
}
let contexts: Array<ReturnType<typeof fakeContext>> = [];
const captureContext = () => contexts[0];

function installHtmlInCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    const ctx = fakeContext();
    contexts.push(ctx);
    return ctx as never;
  });
  vi.stubGlobal(
    "CanvasRenderingContext2D",
    class {
      drawElementImage(): void {}
    },
  );
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).requestPaint = () => {};
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return fakeContext();
      }
    },
  );
}

function makeRoot(attrs: Record<string, string> = { "data-motion-blur": "on" }): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("data-composition-id", "main");
  root.setAttribute("data-width", "640");
  root.setAttribute("data-height", "360");
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  document.body.append(root);
  return root;
}

function host(
  root: HTMLElement,
  seek = vi.fn(),
): CaptureMotionBlurHost & { seek: ReturnType<typeof vi.fn> } {
  return { root, fps: 30, durationSeconds: () => 1, timeline: () => "tl", seek };
}

const captureCanvas = (root: HTMLElement) => root.parentElement as HTMLCanvasElement;

beforeEach(() => {
  contexts = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetCaptureMotionBlurForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).requestPaint;
  delete win.__HF_PAGE_MOTION_BLUR_OFF__;
  delete win.__HF_PAGE_MOTION_BLUR_DEFAULT__;
  delete win.__hfMotionBlur;
  delete win.__hf_page_composite_pending;
  delete win.__hf_page_composite_resolve;
  document.body.innerHTML = "";
});

/** A root with one 10×10 element that slides 300 px over the 1 s composition (10 px/frame). */
function movingHost(attrs?: Record<string, string>) {
  const root = makeRoot(attrs);
  const el = document.createElement("div");
  el.id = "slider";
  root.append(el);
  for (const [k, v] of Object.entries({
    offsetWidth: 10,
    offsetHeight: 10,
    offsetLeft: 0,
    offsetTop: 0,
    offsetParent: root,
  })) {
    Object.defineProperty(el, k, { value: v, configurable: true });
  }
  const x = () => Number(/,\s*([-\d.]+),\s*0\)$/.exec(el.style.transform)?.[1] ?? 0);
  el.getBoundingClientRect = () =>
    ({ left: x(), top: 0, right: x() + 10, bottom: 10, width: 10, height: 10 }) as DOMRect;
  const seek = vi.fn((t: number) => {
    el.style.transform = `matrix(1, 0, 0, 1, ${300 * t}, 0)`;
  });
  return { root, el, h: host(root, seek) };
}

const PLAY = { playing: true };

describe("opt-in and off switches", () => {
  it("does nothing for a root that has not opted in", () => {
    installHtmlInCanvas();
    const root = makeRoot({});
    initCaptureMotionBlur(host(root));
    expect(root.parentElement).toBe(document.body);
    expect(paintCaptureMotionBlur(0)).toBeNull();
  });

  it("stays off without html-in-canvas and says why", () => {
    const root = makeRoot();
    initCaptureMotionBlur(host(root));
    expect(root.parentElement).toBe(document.body);
    expect(win.__hfMotionBlur?.report()).toMatchObject({
      state: "off",
      reason: expect.stringContaining("html-in-canvas"),
    });
  });

  it("stays off in a browser with canvas but without drawElementImage (stable Chrome)", () => {
    installHtmlInCanvas();
    vi.stubGlobal("CanvasRenderingContext2D", class {});
    const root = makeRoot();
    initCaptureMotionBlur(host(root));
    expect(root.parentElement).toBe(document.body);
  });

  it("stays off while the engine's own sub-frame blur is on (never both)", () => {
    installHtmlInCanvas();
    win.__HF_PAGE_MOTION_BLUR_OFF__ = "engine-motion-blur";
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    expect(paintCaptureMotionBlur(0.5, PLAY)).toBeNull();
    expect(root.parentElement).toBe(document.body);
    expect(win.__hfMotionBlur?.report().reason).toContain("engine");
  });

  it("is on by default when the host says so, for a root that did not opt in", () => {
    installHtmlInCanvas();
    win.__HF_PAGE_MOTION_BLUR_DEFAULT__ = true;
    const { root, h } = movingHost({});
    initCaptureMotionBlur(h);
    expect(paintCaptureMotionBlur(0.5, PLAY)).not.toBeNull();
    expect(captureCanvas(root).tagName).toBe("CANVAS");
  });

  it("stays off by default for a root that opts out", () => {
    installHtmlInCanvas();
    win.__HF_PAGE_MOTION_BLUR_DEFAULT__ = true;
    const { root, h } = movingHost({ "data-motion-blur": "off" });
    initCaptureMotionBlur(h);
    expect(paintCaptureMotionBlur(0.5, PLAY)).toBeNull();
    expect(root.parentElement).toBe(document.body);
  });

  it("says why it is off only to a root that asked for it", () => {
    win.__HF_PAGE_MOTION_BLUR_DEFAULT__ = true;
    initCaptureMotionBlur(host(makeRoot({})));
    expect(console.info).not.toHaveBeenCalled();
    resetCaptureMotionBlurForTests();
    initCaptureMotionBlur(host(makeRoot()));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("html-in-canvas"));
  });

  it("stays off when the composition already nests a capture canvas", () => {
    installHtmlInCanvas();
    const root = makeRoot();
    const inner = document.createElement("canvas");
    inner.setAttribute("layoutsubtree", "");
    root.append(inner);
    initCaptureMotionBlur(host(root));
    expect(root.parentElement).toBe(document.body);
  });

  it("clamps the shutter angle", () => {
    installHtmlInCanvas();
    const root = makeRoot({ "data-motion-blur": "on", "data-motion-blur-shutter": "9999" });
    initCaptureMotionBlur(host(root));
    expect(win.__hfMotionBlur?.report().shutterDeg).toBe(720);
  });
});

describe("wrapping", () => {
  it("wraps the root itself in a capture canvas, with an output canvas after it", () => {
    installHtmlInCanvas();
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    expect(root.parentElement).toBe(document.body); // not until it plays
    void paintCaptureMotionBlur(0.5, PLAY);
    const src = captureCanvas(root);
    expect(src.tagName).toBe("CANVAS");
    expect(src.hasAttribute("layoutsubtree")).toBe(true);
    expect(src.hasAttribute("data-hf-ignore")).toBe(true);
    expect([src.width, src.height]).toEqual([640, 360]);
    const out = src.nextElementSibling as HTMLElement;
    expect(out.getAttribute("data-hf-motion-blur")).toBe("output");
    // The output sits over the composition: clicks must reach what is under it.
    expect(out.style.pointerEvents).toBe("none");
  });

  it("unwraps when the root opts back out", () => {
    installHtmlInCanvas();
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    void paintCaptureMotionBlur(0.5, PLAY);
    root.removeAttribute("data-motion-blur");
    initCaptureMotionBlur(h);
    expect(root.parentElement).toBe(document.body);
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
    expect(win.__hfMotionBlur).toBeUndefined();
  });

  it("turns off instead of wrapping when a capture canvas appears after init", () => {
    installHtmlInCanvas();
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    const late = document.createElement("canvas");
    late.setAttribute("layoutsubtree", "");
    root.append(late);
    void paintCaptureMotionBlur(0.5, PLAY);
    expect(root.parentElement).toBe(document.body);
    expect(win.__hfMotionBlur?.report().state).toBe("off");
  });

  it("never wraps a composition where nothing moves", () => {
    installHtmlInCanvas();
    const root = makeRoot();
    initCaptureMotionBlur(host(root));
    void paintCaptureMotionBlur(0.5, PLAY);
    expect(root.parentElement).toBe(document.body);
  });

  it("unwraps when paused, so Studio can select inside, and wraps again on play", async () => {
    installHtmlInCanvas();
    const { root, el, h } = movingHost();
    initCaptureMotionBlur(h);
    const inFlight = paintCaptureMotionBlur(0.5, PLAY);
    captureCanvas(root).dispatchEvent(new Event("paint")); // movers hidden mid-frame
    expect(paintCaptureMotionBlur(0.5)).toBeNull();
    await inFlight; // the dropped frame still settles
    expect(root.parentElement).toBe(document.body);
    expect(el.hasAttribute(HIDE)).toBe(false);
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
    void paintCaptureMotionBlur(0.6, PLAY);
    expect(captureCanvas(root).tagName).toBe("CANVAS");
  });

  it("never unwraps once the engine drives frames", () => {
    installHtmlInCanvas();
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    void paintCaptureMotionBlur(0.5, { engineMode: true });
    // A paused-style request from the transport during a render: it still paints.
    expect(paintCaptureMotionBlur(0.5)).not.toBeNull();
    expect(captureCanvas(root).tagName).toBe("CANVAS");
  });

  it("shows the first frame after wrapping sharp, not the last one from before", () => {
    installHtmlInCanvas();
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    void paintCaptureMotionBlur(0.5, PLAY);
    captureCanvas(root).dispatchEvent(new Event("paint"));
    expect(contexts[1]?.drawImage).toHaveBeenCalledWith(captureCanvas(root), 0, 0);
  });
});

const HIDE = "data-hf-motion-blur-hide";

describe("two-phase frames", () => {
  it("hides the movers for a background capture, then reveals them and settles", async () => {
    installHtmlInCanvas();
    const { root, el, h } = movingHost();
    initCaptureMotionBlur(h);
    const done = paintCaptureMotionBlur(0.5, PLAY);
    expect(win.__hfMotionBlur?.report().moverNames).toEqual(["div#slider"]);
    captureCanvas(root).dispatchEvent(new Event("paint"));
    expect(el.hasAttribute(HIDE)).toBe(true);
    expect(captureContext()?.drawElementImage).toHaveBeenCalledTimes(1);
    captureCanvas(root).dispatchEvent(new Event("paint"));
    await done;
    expect(el.hasAttribute(HIDE)).toBe(false);
    expect(captureContext()?.drawElementImage).toHaveBeenCalledTimes(2);
  });

  it("does not abandon a frame in flight: newer requests collapse into the latest", async () => {
    installHtmlInCanvas();
    const { root, el, h } = movingHost();
    initCaptureMotionBlur(h);
    const first = paintCaptureMotionBlur(0.5, PLAY);
    captureCanvas(root).dispatchEvent(new Event("paint")); // movers cropped, now hidden
    const seeksBefore = h.seek.mock.calls.length;
    const second = paintCaptureMotionBlur(0.6, PLAY);
    const third = paintCaptureMotionBlur(0.7, PLAY);
    // Queued, not started: no pose reads yet, and the first frame keeps its movers hidden.
    expect(h.seek.mock.calls.length).toBe(seeksBefore);
    expect(el.hasAttribute(HIDE)).toBe(true);
    captureCanvas(root).dispatchEvent(new Event("paint")); // first frame done → 0.7 starts
    await first;
    expect(h.seek.mock.calls.at(-1)?.[0]).toBe(0.7);
    captureCanvas(root).dispatchEvent(new Event("paint"));
    captureCanvas(root).dispatchEvent(new Event("paint"));
    await Promise.all([second, third]);
    expect(el.hasAttribute(HIDE)).toBe(false);
  });

  it("reveals the movers if the second paint never comes", async () => {
    vi.useFakeTimers();
    installHtmlInCanvas();
    const { root, el, h } = movingHost();
    initCaptureMotionBlur(h);
    void paintCaptureMotionBlur(0.5, PLAY);
    captureCanvas(root).dispatchEvent(new Event("paint"));
    expect(el.hasAttribute(HIDE)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(el.hasAttribute(HIDE)).toBe(false);
  });

  it("finishes in one capture when the engine's step runs before any paint", () => {
    installHtmlInCanvas();
    const { el, h } = movingHost();
    initCaptureMotionBlur(h);
    void paintCaptureMotionBlur(0.5, { engineMode: true });
    win.__hf_page_composite_resolve?.();
    expect(el.hasAttribute(HIDE)).toBe(false);
    expect(captureContext()?.drawElementImage).toHaveBeenCalledTimes(1);
  });

  it("lets the engine's composite step finish a half-done frame", () => {
    installHtmlInCanvas();
    const { root, el, h } = movingHost();
    initCaptureMotionBlur(h);
    void paintCaptureMotionBlur(0.5, { engineMode: true });
    captureCanvas(root).dispatchEvent(new Event("paint"));
    win.__hf_page_composite_resolve?.();
    expect(el.hasAttribute(HIDE)).toBe(false);
    expect(captureContext()?.drawElementImage).toHaveBeenCalledTimes(2);
  });
});

describe("painting", () => {
  it("captures the root on the next paint and settles the frame", async () => {
    installHtmlInCanvas();
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    const done = paintCaptureMotionBlur(0.5, PLAY);
    expect(done).not.toBeNull();
    captureCanvas(root).dispatchEvent(new Event("paint"));
    captureCanvas(root).dispatchEvent(new Event("paint"));
    await done;
    expect(captureContext()?.drawElementImage).toHaveBeenCalledWith(root, 0, 0);
    // Reset before each capture and again after it: the capture canvas sits under the output
    // and must never show its own bitmap (a transparent composition would show it doubled).
    expect(captureContext()?.reset).toHaveBeenCalledTimes(4);
    // The discovery scan's last word is the frame time: the page is left where it was seeked.
    expect(h.seek.mock.calls.at(-1)?.[0]).toBe(0.5);
  });

  it("seeks pose reads with events suppressed unless the root allows them", () => {
    installHtmlInCanvas();
    const quiet = host(makeRoot());
    initCaptureMotionBlur(quiet);
    void paintCaptureMotionBlur(0.5, PLAY);
    expect(quiet.seek.mock.calls.every(([, suppress]) => suppress === true)).toBe(true);

    resetCaptureMotionBlurForTests();
    const eventful = host(makeRoot({ "data-motion-blur": "on", "data-motion-blur-events": "on" }));
    initCaptureMotionBlur(eventful);
    void paintCaptureMotionBlur(0.5, PLAY);
    expect(eventful.seek.mock.calls.every(([, suppress]) => suppress === false)).toBe(true);
  });

  it("in engine mode composes with the prior composite owner and draws even without a paint event", () => {
    installHtmlInCanvas();
    const prior = vi.fn(() => true);
    win.__hf_page_composite_resolve = prior;
    const { h } = movingHost();
    initCaptureMotionBlur(h);
    void paintCaptureMotionBlur(0.5, { engineMode: true });
    expect(win.__hf_page_composite_pending).toBe(true);
    win.__hf_page_composite_resolve?.();
    expect(prior).toHaveBeenCalled();
    expect(captureContext()?.drawElementImage).toHaveBeenCalledTimes(1);
    expect(win.__hf_page_composite_pending).toBe(false);
  });

  it("re-scans for movers when the runtime binds a different timeline", () => {
    installHtmlInCanvas();
    let timeline = "first";
    const h = { ...host(makeRoot()), timeline: () => timeline };
    initCaptureMotionBlur(h);
    const frame = (t: number): void => {
      void paintCaptureMotionBlur(t, PLAY);
      captureCanvas(h.root).dispatchEvent(new Event("paint"));
    };
    frame(0.5);
    const afterFirst = h.seek.mock.calls.length;
    frame(0.6);
    const steady = h.seek.mock.calls.length - afterFirst;
    timeline = "second";
    frame(0.7);
    // A scan seeks once per frame of the composition (30 here); a plain frame seeks far less.
    expect(h.seek.mock.calls.length - afterFirst - steady).toBeGreaterThan(steady + 30);
  });

  it("gives up on a frame whose paint never comes", async () => {
    vi.useFakeTimers();
    installHtmlInCanvas();
    initCaptureMotionBlur(movingHost().h);
    const done = paintCaptureMotionBlur(0.5, PLAY);
    let settled = false;
    void done?.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("turns itself off and unwraps after repeated capture failures", async () => {
    installHtmlInCanvas();
    const { root, h } = movingHost();
    initCaptureMotionBlur(h);
    for (let i = 0; i < 3; i++) {
      const done = paintCaptureMotionBlur(i / 30, PLAY);
      captureContext()?.drawElementImage.mockImplementation(() => {
        throw new Error("No cached paint record");
      });
      captureCanvas(root).dispatchEvent(new Event("paint"));
      await done;
    }
    expect(root.parentElement).toBe(document.body);
    expect(win.__hfMotionBlur?.report()).toMatchObject({ state: "off" });
  });
});
