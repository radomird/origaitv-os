// A web app whose site refuses the daemon's own request for its icon, as
// some sites refuse anything that isn't a browser (daemon/page-icon.ts). Its
// tile had its letters. Once its page is open in the TV's browser, the
// screen daemon reads the icon there, in a world of its own, and the daemon
// keeps it: home and Apps then show it. The site is a stand-in made here,
// which answers 403 to OrigaiTV's own requests and serves a browser, and
// whose page swaps its own fetch for one that lies.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { CdpPipe } from "../../../daemon/cdp.ts";
import { ICON_WORLD, PAGE_ICON, type PageIcon } from "../../../daemon/page-icon.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000b4000000b40806000000", "hex");
const SMALL = Buffer.from("89504e470d0a1a0a0000000d4948445200000020000000200806000000", "hex");
const APP = "local.refuses";

let site: Server;
let base = "";
let refused = 0;
let browser: Browser;
let services: ChildProcess;
let cdp: CdpPipe;
let daemon: Daemon;
let url = "";
const errors: string[] = [];

before(async () => {
  site = createServer((request, response) => {
    // Anything that says it's OrigaiTV is refused, as some sites do.
    if (/^OrigaiTV/.test(request.headers["user-agent"] ?? "")) {
      refused++;
      response.writeHead(403, { "Content-Type": "text/html" });
      response.end("not for robots");
      return;
    }
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><title>Refuses</title><link rel="icon" href="/small.png" sizes="32x32"><link rel="apple-touch-icon" href="/touch.png">' +
          '<link rel="icon" href="https://elsewhere.example/huge.png" sizes="1024x1024">' +
          "<script>window.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });</script><p>A stand-in.</p>",
      );
    } else if (path === "/none/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>None</title><p>No icons here.</p>");
    } else if (path === "/touch.png" || path === "/small.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(path === "/touch.png" ? PNG : SMALL);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  ({ daemon, url } = await startBox(0, [
    ...FIXTURES,
    {
      id: APP,
      name: "Refuses",
      tier: "local",
      category: "streaming",
      edit: (m) => {
        m.tv.homeUrl = `${base}/`;
        m.tv.origins = [base];
        m.tv.capabilities = ["launch"];
        delete m.tv.setup;
        delete m.tv.icon;
        delete m.tv.tiles;
      },
    },
  ]));
  await fetch(`${url}/api/layout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout: [{ id: APP, x: 0, y: 0, size: "s" }, { id: "apps", x: 1, y: 0, size: "s" }] }),
  });
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  // The services' browser, as the screen daemon holds it: over a pipe.
  services = spawn(process.env.ORIGAITV_UI_BROWSER!, ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", `--user-data-dir=${mkdtempSync(join(tmpdir(), "origaitv-icon-"))}`, "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  cdp = new CdpPipe(services.stdio[3] as Writable, services.stdio[4] as Readable);
});

after(async () => {
  services?.kill();
  await browser?.close();
  await daemon?.close();
  site?.close();
});

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);

// What the tile shows, on home and in Apps: its icon, or its letters.
async function tiles(): Promise<{ home: string; apps: string }> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForSelector(`.grid .tile[data-id="${APP}"]`);
  await rest(page);
  const shown = (selector: string) => page.$eval(selector, (el) => el.querySelector(".logo img")?.getAttribute("src") ?? el.querySelector(".logo")?.textContent ?? "");
  const home = await shown(`.grid .tile[data-id="${APP}"]`);
  await go(page, "apps");
  await page.waitForSelector(`#page .tile[data-id="${APP}"]`);
  const apps = await shown(`#page .tile[data-id="${APP}"]`);
  await page.close();
  return { home, apps };
}

// The page's icon, read the way the screen daemon reads it, until the page
// has loaded.
async function read(path: string): Promise<PageIcon | null> {
  const target = await cdp.open(`${base}${path}`);
  try {
    for (let tries = 0; tries < 50; tries++) {
      const said = (await cdp.evaluateInWorld(target, ICON_WORLD, PAGE_ICON)) as PageIcon | { wait: true } | null;
      if (said === null || !("wait" in said)) return said;
      await sleep(100);
    }
    throw new Error("the page never loaded");
  } finally {
    await cdp.close(target);
  }
}

test("T30.10 a site that refuses the daemon: letters at first, then its icon read from its page, on home and in Apps", async () => {
  // The daemon asks the site itself first, and is refused.
  for (let i = 0; i < 50 && refused === 0; i++) await (await fetch(`${url}/api/home`)).json().then(() => sleep(100));
  assert.ok(refused > 0, "the daemon asked, and was refused");
  assert.deepEqual(await tiles(), { home: "RE", apps: "RE" }, "its letters while it has no icon");
  assert.deepEqual(await (await fetch(`${url}/api/apps/${APP}/site-icon`)).json(), { ok: true, wanted: true });

  // Its page in the TV's browser: the biggest icon on its own site, read in
  // a world of its own, so the page's lying fetch changes nothing, and none
  // from another site.
  const icon = await read("/");
  assert.ok(icon, "an icon was read");
  assert.equal(icon!.type, "image/png");
  assert.equal(icon!.from, `${base}/touch.png`);
  assert.ok(Buffer.from(icon!.data, "base64").equals(PNG), "the site's own bytes");

  // Handed to the daemon as the screen daemon hands it, and kept.
  const kept = await fetch(`${url}/api/apps/${APP}/site-icon`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(icon) });
  assert.deepEqual(await kept.json(), { ok: true });
  assert.deepEqual(await (await fetch(`${url}/api/apps/${APP}/site-icon`)).json(), { ok: true, wanted: false });
  const shown = await tiles();
  assert.match(shown.home, new RegExp(`^/api/apps/${APP.replace(".", "\\.")}/icon\\?v=`), "home shows its icon");
  assert.equal(shown.apps, shown.home, "and so does Apps");
  const served = await fetch(`${url}${shown.home}`);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(PNG));
  assert.deepEqual(errors, []);
});

test("T30.10 a page that names no icon, with no favicon, gives nothing to read", async () => {
  assert.equal(await read("/none/"), null);
});
