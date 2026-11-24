// A web app's site icon, read in the TV's own browser from the app's page,
// once it's open there. The daemon asks the site for its icon itself
// (daemon/site-icon.ts), but some sites refuse a request that isn't a
// browser's, and their tiles kept their letters. The browser that shows the
// page asks for the same icon to show it, so the screen daemon reads it
// there and hands it to the daemon, which keeps it as it keeps its own.
//
// PAGE_ICON runs in an isolated world of the page (ICON_WORLD), so the
// page's own scripts can't change what it finds or how it asks. It takes
// the icons the page names, best first, the way siteIcon ranks them, then
// /favicon.ico. Only ones on the page's own origin: that's what its browser
// may read, and an icon on another site is the daemon's to fetch. The
// daemon keeps it only from one of the app's own origins. It answers
// {wait: true} while the page is still loading, null when there's no icon
// to read, or the icon as base64.

import { ICON_MAX } from "./site-icon.ts";

export const ICON_WORLD = "origaitv-icon";

export interface PageIcon {
  type: string;
  data: string;
  from: string;
}

export const PAGE_ICON = `(async () => {
  if (document.readyState !== "complete") return { wait: true };
  const TYPES = /^image\\/(png|jpeg|webp|gif|avif|svg\\+xml|x-icon|vnd\\.microsoft\\.icon)$/;
  const found = [];
  for (const link of document.querySelectorAll("link[rel][href]")) {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\\s+/);
    const touch = rel.some((r) => r.startsWith("apple-touch-icon"));
    if (!rel.includes("icon") && !touch) continue;
    let url;
    try {
      url = new URL(link.getAttribute("href"), document.baseURI);
    } catch {
      continue;
    }
    const sizes = (link.getAttribute("sizes") || "").toLowerCase();
    const size = sizes === "any" ? 512 : Math.max(0, ...sizes.split(/\\s+/).map((s) => Number(s.split("x")[0]) || 0));
    found.push({ url: url.href, score: (size || (touch ? 180 : 16)) * 2 + (touch ? 1 : 0) });
  }
  found.sort((a, b) => b.score - a.score);
  const candidates = [...new Set([...found.map((f) => f.url), location.origin + "/favicon.ico"])];
  for (const candidate of candidates) {
    const url = new URL(candidate);
    if (url.origin !== location.origin) continue;
    try {
      const response = await fetch(url.href, { credentials: "omit" });
      if (!response.ok) continue;
      let type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!TYPES.test(type) && url.pathname.endsWith(".ico")) type = "image/x-icon";
      if (!TYPES.test(type)) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > ${ICON_MAX}) continue;
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { type, data: btoa(text), from: url.href };
    } catch {}
  }
  return null;
})()`;
