// T29.6: a page opened while the builds list is on its way draws with it,
// in a real Chromium. A word about the builds comes on home, and the list
// it asks for is held. A page that shows builds, opened meanwhile, was drawn
// with the old list, so it's drawn again once the new one is in. Edit mode
// opened the same way is left as it is, with an app still in hand.

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
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state, builds } = await startBox(0, undefined, { features: PHASE_1 }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
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
    // And how many of the page's event streams have opened. The launcher
    // catches up each time its own opens, and draws the page again once
    // the builds list it asks for is in, whichever ask brought it.
    const heard = { builds: 0, opened: 0 };
    (window as unknown as { heard: typeof heard }).heard = heard;
    const Source = window.EventSource;
    window.EventSource = class extends Source {
      constructor(...args: ConstructorParameters<typeof EventSource>) {
        super(...args);
        this.addEventListener("open", () => heard.opened++);
      }
    };
    new EventSource("/api/events").addEventListener("builds", () => heard.builds++);
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  // The launcher's catching up done, so the only page drawn again with the
  // list is the one the word draws.
  await page.waitForFunction(() => (window as unknown as { heard: { opened: number } }).heard.opened >= 2);
  await page.waitForTimeout(500);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);

// The page on screen, kept aside, and whether it still is.
const keep = (page: Page) => page.evaluate(() => void ((window as unknown as { kept: Element | null }).kept = document.querySelector("#page")!.firstElementChild));
const stillKept = (page: Page) => page.evaluate(() => (window as unknown as { kept: Element | null }).kept?.isConnected === true);
const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: { builds: number } }).heard.builds);

// Root's part: what was asked, as the daemon keeps it, and how the build
// stands, as the builder writes it. Each one is a new build, so each test
// has a word of its own to wait for.
function build(id: string, change: Record<string, unknown> = {}): void {
  writeFileSync(join(state, "builds.json"), JSON.stringify([{ build: id, id: `local.${id}`, version: "1.0.0", sentence: "a game like tetris", provider: "claude", path: "key", at: "2026-11-23T10:00:00.000Z" }]));
  const dir = join(builds, `local.${id}`, "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ build: id, id: `local.${id}`, version: "1.0.0", phase: "build", state: "running", steps: [{ id: "design", state: "running" }], started: "", at: new Date().toISOString(), ...change }));
}

// The list a word about the builds asks for, held until let go. Resolves
// once the word was heard and its list asked for.
async function holdList(page: Page, id: string): Promise<() => Promise<void>> {
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
  build(id);
  await listAsked;
  await page.waitForFunction((n) => (window as unknown as { heard: { builds: number } }).heard.builds > n, before, { timeout: 5000 });
  return async () => {
    const landed = page.waitForResponse("**/api/builds");
    answer();
    await landed;
    await page.unroute("**/api/builds");
  };
}

test("T29.6 a word about builds comes on home, Apps is opened before the list lands, and Apps then shows the new list", async () => {
  const page = await tv();
  try {
    const letGo = await holdList(page, "blocks");
    await go(page, "apps");
    await page.waitForSelector(".apps-page");
    // Drawn with the list as it was: no such build yet.
    assert.equal(await page.locator('.build-tile[data-build="blocks"]').count(), 0, "Apps opened with the old list");
    await letGo();
    await page.waitForSelector('.build-tile[data-build="blocks"]', { timeout: 2000 }).catch(() => null);
    assert.equal(await page.locator('.build-tile[data-build="blocks"]').count(), 1, "Apps shows the new list");
  } finally {
    await page.close();
  }
});

test("T29.6 edit mode opened before the list lands isn't drawn again, and an app in hand stays in hand", async () => {
  const page = await tv();
  try {
    const letGo = await holdList(page, "snake");
    const tile = await page.locator(".grid .tile.focused").getAttribute("data-id");
    await go(page, `edit/${tile}`);
    await page.waitForSelector(".grid.editing .tile.focused");
    // Picked up and carried one cell, not put down yet.
    await page.keyboard.press("Enter");
    await page.waitForSelector(".grid.editing .tile.held");
    const held = page.locator(".grid.editing .tile.held");
    // Its cell, not the rest of its style, which the move animates.
    const cell = () => held.evaluate((el) => (el as HTMLElement).style.gridArea);
    const picked = await cell();
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft"]) {
      await page.keyboard.press(key);
      if ((await cell()) !== picked) break;
    }
    const at = await cell();
    assert.notEqual(at, picked, "the app was carried");
    await keep(page);
    await letGo();
    await page.waitForTimeout(300);
    assert.ok(await stillKept(page), "edit mode wasn't drawn again");
    assert.equal(await held.getAttribute("data-id"), tile, "the same app is in hand");
    assert.equal(await cell(), at, "where it was carried to");
  } finally {
    await page.close();
  }
});
