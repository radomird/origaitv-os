// The release in Settings, System, in a real Chromium (T30.3's layer 4
// half): a TV installed from the 1.0.0-rc4 ISO, on edge, says OrigaiTV
// 1.0.0-rc4 on System's About row and on About, with its build on a line of
// its own under each. A stable one says its release and no build. A build
// with no release says its build, as before.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { rest, startBox } from "./box.mts";
import { shortfalls } from "./legible.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const LOOKS = ["terminal", "glass", "cinema"] as const;
const BUILD = "0.2.0.r1061.g91b63a2e0";

let browser: Browser;
const daemons: Daemon[] = [];
const errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  for (const daemon of daemons) await daemon.close();
  assert.deepEqual(errors, []);
});

async function box(version: string, channel: string, release?: string): Promise<string> {
  const { daemon, url } = await startBox(0, undefined, { settings: `ORIGAITV_VERSION=${version}\nORIGAITV_CHANNEL=${channel}\n`, release });
  daemons.push(daemon);
  return url;
}

async function tv(url: string, look: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  const set = await fetch(`${url}/api/look`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) });
  assert.equal(set.ok, true, `the look is ${look}`);
  await page.goto(`${url}/`);
  await page.waitForSelector("html[data-look] #page .focused");
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);
// The words as written, before a look lowers them.
// A row's parts, its name and its value, read with a space between them.
const text = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => (el.children.length ? [...el.children].map((part) => part.textContent ?? "").filter(Boolean).join(" ") : (el.textContent ?? "")).replace(/\s+/g, " ").trim());

// System's rows: the About row's value, and the Build row's if there is one.
async function system(page: Page): Promise<{ about: string; build: string | null }> {
  await go(page, "settings/tv");
  await page.waitForSelector('.panel [data-action="about"]');
  const about = await text(page, '.panel [data-action="about"] .button-value');
  const build = (await page.locator('.panel [data-row="build"]').count()) ? await text(page, '.panel [data-row="build"]') : null;
  return { about, build };
}

// About's own page: its big line, and its build line if there is one.
async function about(page: Page): Promise<{ big: string; build: string | null }> {
  await go(page, "settings/about");
  await page.waitForSelector(".panel .panel-big");
  const big = await text(page, ".panel .panel-big");
  const build = (await page.locator('.panel [data-row="build"]').count()) ? await text(page, '.panel [data-row="build"]') : null;
  return { big, build };
}

for (const look of LOOKS) {
  test(`T30.3 an edge TV from the 1.0.0-rc4 ISO says 1.0.0-rc4, with its build on a line of its own, in ${look}`, async () => {
    const page = await tv(await box(BUILD, "edge", "1.0.0-rc4\n"), look);
    assert.deepEqual(await system(page), { about: "OrigaiTV 1.0.0-rc4", build: `Build ${BUILD}` });
    assert.deepEqual(await about(page), { big: "OrigaiTV 1.0.0-rc4", build: `Build ${BUILD}` });
    // The build's line is a line, not a row to press: OK on About goes in.
    await go(page, "settings/tv");
    await page.waitForSelector('.panel [data-row="build"]');
    assert.equal(await page.locator('.panel [data-row="build"][data-focus]').count(), 0);
    // And it fits, on one line, inside the panel.
    const fits = await page.locator('.panel [data-row="build"]').evaluate((row) => {
      const panel = row.closest(".panel")!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return box.left >= panel.left - 1 && box.right <= panel.right + 1 && row.scrollWidth <= row.clientWidth + 1;
    });
    assert.equal(fits, true, "the build's line fits the panel");
    await rest(page);
    // Until the page's fade-in is done, which Terminal takes longest over.
    await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 10_000 });
    assert.deepEqual(await shortfalls(page), [], "System reads clearly");
    await page.close();
  });
}

test("T30.3 a stable TV says its release, and no build", async () => {
  const page = await tv(await box("1.0.0", "stable", "1.0.0-rc4\n"), "glass");
  assert.deepEqual(await system(page), { about: "OrigaiTV 1.0.0", build: null });
  assert.deepEqual(await about(page), { big: "OrigaiTV 1.0.0", build: null });
  await page.close();
});

test("an edge TV with no release says its build, as it did before", async () => {
  const page = await tv(await box(BUILD, "edge"), "glass");
  assert.deepEqual(await system(page), { about: "OrigaiTV 0.2.0", build: `Build ${BUILD}` });
  assert.deepEqual(await about(page), { big: "OrigaiTV 0.2.0", build: `Build ${BUILD}` });
  await page.close();
});
