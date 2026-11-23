// T29.5: the daemon's first look at the builds is quiet, in a real Chromium.
// It looks as it starts, so two seconds in it has nothing new to say, and
// the page on screen isn't drawn again for nothing. A build that really
// moves on is still heard at the next look, and its page follows. And a word
// about the builds draws again only the page that was in front when it
// came: one opened while the list was on its way, such as edit mode, is
// left as it is.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { PHASE_1, startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let builds = "";
let started = 0;
const errors: string[] = [];

before(async () => {
  // The browser first, so its own start doesn't count against the
  // daemon's two seconds: on a busy machine it alone can take one.
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
  started = Date.now();
  ({ daemon, url, state, builds } = await startBox(0, undefined, { features: PHASE_1 }));
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true, apps: [] })), 0);
    };
    // Every word about the builds the page hears, counted beside the
    // launcher's own.
    const heard = { builds: 0 };
    (window as unknown as { heard: typeof heard }).heard = heard;
    new EventSource("/api/events").addEventListener("builds", () => heard.builds++);
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);

// The page on screen, kept aside, and whether it still is.
const keep = (page: Page) => page.evaluate(() => void ((window as unknown as { kept: Element | null }).kept = document.querySelector("#page")!.firstElementChild));
const stillKept = (page: Page) => page.evaluate(() => (window as unknown as { kept: Element | null }).kept?.isConnected === true);
const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: { builds: number } }).heard.builds);

// Root's part: what was asked, as the daemon keeps it, and how the build
// stands, as the builder writes it.
function build(change: Record<string, unknown>): void {
  writeFileSync(join(state, "builds.json"), JSON.stringify([{ build: "b1", id: "local.blocks", version: "1.0.0", sentence: "a game like tetris", provider: "claude", path: "key", at: "2026-11-22T18:00:00.000Z" }]));
  const dir = join(builds, "local.blocks", "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ build: "b1", id: "local.blocks", version: "1.0.0", phase: "build", state: "running", steps: [], started: "", at: new Date().toISOString(), ...change }));
}

test("T29.5 two seconds after the daemon starts with nothing new, the page on screen isn't drawn again", async () => {
  const page = await tv();
  try {
    assert.ok(Date.now() - started < 2000, `home was open ${Date.now() - started} ms after the daemon started, before its look two seconds in`);
    await keep(page);
    // Past the look two seconds in, with time for a list to be asked for
    // and drawn.
    await page.waitForTimeout(Math.max(0, started + 3000 - Date.now()));
    assert.equal(await heard(page), 0, "no word about the builds");
    assert.ok(await stillKept(page), "home wasn't drawn again");
  } finally {
    await page.close();
  }
});

test("T29.5 a build that moves on is heard at the next look, and its page follows at once", async () => {
  const page = await tv();
  try {
    build({ steps: [{ id: "design", state: "running" }] });
    await page.waitForFunction(() => (window as unknown as { heard: { builds: number } }).heard.builds > 0, undefined, { timeout: 5000 });
    await go(page, "build/b1");
    await page.waitForFunction(() => document.querySelector(".build-page")?.getAttribute("data-state") === "running");
    const asked = Date.now();
    build({ state: "failed", reason: "its tests didn't pass" });
    await page.waitForFunction(() => document.querySelector(".build-page")?.getAttribute("data-state") === "failed", undefined, { timeout: 5000 });
    assert.ok(Date.now() - asked < 2500, `the page followed in ${Date.now() - asked} ms`);
  } finally {
    await page.close();
  }
});

test("T29.5 a word about the builds draws again only the page that was in front when it came, not edit mode opened meanwhile", async () => {
  const page = await tv();
  try {
    // The list the word asks for is held until edit mode is open.
    let asked!: () => void;
    const listAsked = new Promise<void>((done) => (asked = done));
    let answer!: () => void;
    const answered = new Promise<void>((done) => (answer = done));
    await page.route("**/api/builds", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      asked();
      await answered;
      await route.continue();
    });
    const before = await heard(page);
    build({ state: "failed", reason: "it stopped", at: new Date(Date.now() + 1000).toISOString() });
    await listAsked;
    await page.waitForFunction((n) => (window as unknown as { heard: { builds: number } }).heard.builds > n, before);
    const tile = await page.locator(".grid .tile.focused").getAttribute("data-id");
    await go(page, `edit/${tile}`);
    await page.waitForSelector(".grid.editing .tile.focused");
    await keep(page);
    answer();
    await page.waitForResponse("**/api/builds");
    await page.waitForTimeout(300);
    assert.ok(await stillKept(page), "edit mode wasn't drawn again");
    await page.unroute("**/api/builds");
  } finally {
    await page.close();
  }
});
