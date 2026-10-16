import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeManagedBrowser } from "../browser/launch.js";
import {
  _answerPageInProcessForTests,
  openSettledCompositionPage,
} from "./captureCompositionFrame.js";
import { allowedLocalOnlyRequest } from "./localOnlyRequests.js";

describe("allowedLocalOnlyRequest", () => {
  const server = "http://127.0.0.1:4100/index.html";
  it.each([
    ["http://127.0.0.1:4100/assets/a.png", true],
    ["data:image/png;base64,AAAA", true],
    ["blob:http://127.0.0.1:4100/1234", true],
    ["https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js", true],
    ["https://fonts.googleapis.com/css2?family=Inter", true],
    ["https://fonts.gstatic.com/s/inter/v13/a.woff2", true],
    ["http://127.0.0.1:4101/secret", false],
    ["https://example.com/", false],
    ["https://cdn.jsdelivr.net/gh/someone/repo/payload.txt", false],
    ["https://cdn.jsdelivr.net/npm/gsap-extra/index.js", false],
    ["https://fonts.googleapis.com.example.com/x", false],
    ["https://fonts.googleapis.com@example.com/x", false],
    ["https://fonts.googleapis.com:8443/css2", false],
    ["http://fonts.googleapis.com/css2", false],
  ])("%s -> %s", (url, allowed) => {
    expect(allowedLocalOnlyRequest(url, server)).toBe(allowed);
  });
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<[Server, string]> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return [server, `127.0.0.1:${(server.address() as AddressInfo).port}`];
}

// A loaded Windows runner can take over 10 s to load one page while sibling suites launch Chrome.
const LOAD_MS = 30_000;

// Each probe sets document.title once its attempt settled, either way.
const PROBES: Record<string, string> = {
  fetch: `fetch("http://FOREIGN/x").then((r) => r.text()).then((t) => { document.title = t; }, () => { document.title = "blocked"; });`,
  "shared worker": `const w = new SharedWorker("/shared.js"); w.port.onmessage = (e) => { document.title = e.data; };`,
  "service worker": `navigator.serviceWorker.register("/sw.js").then((reg) => {
    const w = reg.installing; w.onstatechange = () => { if (w.state !== "installing") document.title = w.state; };
  }, () => { document.title = "refused"; });`,
  websocket: `const ws = new WebSocket("ws://FOREIGN/"); ws.onopen = ws.onerror = () => { document.title = "settled"; };`,
  popup: `window.open("http://FOREIGN/popup"); document.title = "opened";`,
};

const SCRIPTS: Record<string, string> = {
  "/shared.js": `onconnect = (e) => { const port = e.ports[0];
    fetch("http://FOREIGN/shared").then((r) => r.text()).then((t) => port.postMessage(t), () => port.postMessage("blocked")); };`,
  "/sw.js": `self.oninstall = (e) => e.waitUntil(fetch("http://FOREIGN/sw").then((r) => r.text()));`,
};

describe("a --local-only browser", () => {
  let foreign: Server;
  let foreignHost: string;
  let foreignHits = 0;
  let project: Server;
  let projectHost: string;
  let probe = "";
  const html = () => `<!doctype html><html><body>
<div data-composition-id="main" data-width="320" data-height="180" data-duration="1"></div>
<script>window.__timelines={main:{duration:()=>1,seek:()=>{},pause:()=>{}}};
${PROBES[probe]!.replaceAll("FOREIGN", foreignHost)}</script></body></html>`;

  beforeAll(async () => {
    [foreign, foreignHost] = await listen((_req, res) => {
      foreignHits++;
      res.writeHead(200, { "access-control-allow-origin": "*" }).end("FOREIGN TEXT");
    });
    foreign.on("upgrade", (_req, socket) => {
      foreignHits++;
      socket.destroy();
    });
    [project, projectHost] = await listen((req, res) => {
      const script = SCRIPTS[req.url ?? ""];
      if (script) {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(script.replaceAll("FOREIGN", foreignHost));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(html());
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => foreign.close(resolve));
    await new Promise((resolve) => project.close(resolve));
  });

  async function run(
    name: string,
    localOnly: boolean,
  ): Promise<{ title: string; failed: string[] }> {
    probe = name;
    foreignHits = 0;
    const failed: string[] = [];
    let popupSettled: Promise<unknown> = Promise.resolve();
    const { browser, page } = await openSettledCompositionPage(html(), `http://${projectHost}/`, {
      renderReadyTimeoutMs: 2_000,
      navigationTimeoutMs: LOAD_MS,
      renderReadyWarningSuffix: "local-only test",
      browserGpuMode: "software",
      localOnly,
      beforeNavigate: (p) => {
        p.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
        p.on("popup", (popup) => {
          popupSettled =
            popup
              ?.waitForFunction(() => document.readyState === "complete", { timeout: LOAD_MS })
              .catch(() => undefined) ?? Promise.resolve();
        });
      },
    });
    try {
      await page.waitForFunction(() => document.title !== "", { timeout: LOAD_MS });
      await popupSettled;
      return { title: await page.title(), failed };
    } finally {
      await closeManagedBrowser(browser);
    }
  }

  it("reports a blocked page request as a blocked load", async () => {
    const { title, failed } = await run("fetch", true);
    expect(title).toBe("blocked");
    expect(failed).toEqual([`http://${foreignHost}/x net::ERR_BLOCKED_BY_CLIENT.Inspector`]);
  }, 90_000);

  it("leaves an in-process server origin to the handler that answers it", async () => {
    const origin = "http://hyperframes-test.localhost";
    const page = `<!doctype html><html><head><title>in-process</title></head><body>
<div data-composition-id="main" data-width="320" data-height="180" data-duration="1"></div>
<script>window.__timelines={main:{duration:()=>1,seek:()=>{},pause:()=>{}}};</script></body></html>`;
    const session = await openSettledCompositionPage(page, `${origin}/`, {
      renderReadyTimeoutMs: 2_000,
      navigationTimeoutMs: LOAD_MS,
      renderReadyWarningSuffix: "local-only test",
      browserGpuMode: "software",
      localOnly: true,
      beforeNavigate: (p) => {
        p.on("request", (r) => {
          if (r.isInterceptResolutionHandled() || new URL(r.url()).origin !== origin) return;
          void r.respond({ status: 200, contentType: "text/html", body: page }, 0);
        });
      },
    });
    try {
      expect(await session.page.title()).toBe("in-process");
    } finally {
      await closeManagedBrowser(session.browser);
    }
  }, 90_000);

  it.each(Object.keys(PROBES))(
    "keeps a %s from reaching another host",
    async (name) => {
      await run(name, true);
      expect(foreignHits).toBe(0);
    },
    90_000,
  );

  it.each(Object.keys(PROBES))(
    "lets a %s reach it without the flag",
    async (name) => {
      await run(name, false);
      expect(foreignHits).toBeGreaterThan(0);
    },
    90_000,
  );
});

describe("an in-process server's request handler under --local-only", () => {
  const origin = "http://hyperframes-1.localhost";

  /** What the handler did with one request: answered in-process, continued, or aborted. */
  async function handle(url: string, localOnly: boolean): Promise<string> {
    let onRequest!: (request: unknown) => void;
    const page = {
      setRequestInterception: async () => {},
      on: (_: string, h: typeof onRequest) => (onRequest = h),
    };
    const answer = async () => ({ status: 200, headers: {}, body: Buffer.from("ok") });
    await _answerPageInProcessForTests(page as never, `${origin}/`, answer as never, localOnly);
    const done: string[] = [];
    onRequest({
      url: () => url,
      method: () => "GET",
      headers: () => ({}),
      isInterceptResolutionHandled: () => false,
      respond: async () => void done.push("respond"),
      continue: async () => void done.push("continue"),
      abort: async (code: string) => void done.push(`abort ${code}`),
    });
    await vi.waitFor(() => expect(done).toHaveLength(1));
    return done[0]!;
  }

  it.each([
    [`${origin}/index.html`, true, "respond"],
    ["http://127.0.0.1:9999/secret", true, "abort blockedbyclient"],
    ["https://cdn.jsdelivr.net/gh/someone/repo/payload.txt", true, "abort blockedbyclient"],
    ["https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js", true, "continue"],
    ["http://127.0.0.1:9999/secret", false, "continue"],
  ])("%s with localOnly=%s is %s", async (url, localOnly, expected) => {
    expect(await handle(url, localOnly)).toBe(expected);
  });
});
