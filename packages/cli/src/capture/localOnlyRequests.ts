import type { Page } from "puppeteer-core";

// The template CDNs a --local-only page still loads, by host and path: GSAP and Google Fonts.
const TEMPLATE_CDN_PATHS: Record<string, string[]> = {
  "cdn.jsdelivr.net": ["/npm/gsap@", "/npm/gsap/"],
  "fonts.googleapis.com": ["/"],
  "fonts.gstatic.com": ["/"],
};

/**
 * Chrome-wide part of --local-only: every target (workers, service workers, popups, WebSocket)
 * goes through a proxy port nothing serves unless it is the server's own host:port or a CDN host.
 */
export function localOnlyChromeArgs(serverUrl: string): string[] {
  const bypass = ["<-loopback>", new URL(serverUrl).host, ...Object.keys(TEMPLATE_CDN_PATHS)];
  return [
    "--proxy-server=http://127.0.0.1:9",
    `--proxy-bypass-list=${bypass.join(";")}`,
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/** A load --local-only stopped: the page-level guard or the refusing proxy. */
export function isLocalOnlyBlock(errorText: string | undefined): boolean {
  return (
    errorText?.startsWith("net::ERR_BLOCKED_BY_CLIENT") === true ||
    errorText === "net::ERR_PROXY_CONNECTION_FAILED"
  );
}

/** True when a --local-only page may load `url`: the CLI's own server, data:/blob:, or a template CDN. */
export function allowedLocalOnlyRequest(url: string, serverUrl: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  let target: URL;
  try {
    target = new URL(url);
    if (target.origin === new URL(serverUrl).origin) return true;
  } catch {
    return false;
  }
  if (target.protocol !== "https:" || target.port !== "") return false;
  return (
    TEMPLATE_CDN_PATHS[target.hostname]?.some((path) => target.pathname.startsWith(path)) ?? false
  );
}

/** Every other request, redirect hops included, fails as a load blocked by the client. */
export async function guardLocalOnlyRequests(page: Page, serverUrl: string): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled()) return;
    // Priority 0 lets another handler's respond() (an in-process server origin) win over this continue.
    const action = allowedLocalOnlyRequest(request.url(), serverUrl)
      ? request.continue(request.continueRequestOverrides(), 0)
      : request.abort("blockedbyclient", 0);
    void action.catch(() => {});
  });
}
