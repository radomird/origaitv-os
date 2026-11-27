// The release in Settings, System, in a real Chromium (T30.3's layer 4
// half): a TV installed from the 1.0.0-rc4 ISO, still on the build that ISO
// carried, says OrigaiTV 1.0.0-rc4 on System's About row and on About, with
// its build on a line of its own under each. Once an update on edge has moved
// it past that build, it says "Edge channel, installed from 1.0.0-rc4", with
// the new build under it. A stable one says its release and no build. A
// build with no release says its build, as before.

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
const LATER = "0.2.0.r1072.g0c4f00d1e";
// The ISO's file: the release, and the build it carried.
const RC4 = `1.0.0-rc4\n${BUILD}\n`;

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

// The TV in a look, at a size: standard in a 1920 px window, or larger,
// whose bigger words have a 1600 px one, as Settings' own tests have it.
async function tv(url: string, look: string, size: "standard" | "larger" = "standard"): Promise<Page> {
  const width = size === "larger" ? 1600 : 1920;
  const page = await browser.newPage({ viewport: { width, height: Math.round((width * 9) / 16) } });
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
  await page.goto(size === "larger" ? `${url}/?size=larger` : `${url}/`);
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

// System's Build line is a line, not a row to press, and it and the About
// row fit the panel and read clearly.
async function fits(page: Page): Promise<void> {
  await go(page, "settings/tv");
  await page.waitForSelector('.panel [data-row="build"]');
  assert.equal(await page.locator('.panel [data-row="build"][data-focus]').count(), 0);
  for (const selector of ['.panel [data-row="build"]', '.panel [data-action="about"]']) {
    const inside = await page.locator(selector).evaluate((row) => {
      const panel = row.closest(".panel")!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const parts = [row, ...row.children] as HTMLElement[];
      return box.left >= panel.left - 1 && box.right <= panel.right + 1 && parts.every((part) => part.scrollWidth <= part.clientWidth + 1);
    });
    assert.equal(inside, true, `${selector} fits the panel`);
  }
  await rest(page);
  // Until the page's fade-in is done, which Terminal takes longest over.
  await page.waitForFunction(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 10_000 });
  assert.deepEqual(await shortfalls(page), [], "System reads clearly");
}

for (const look of LOOKS) {
  test(`T30.3 an edge TV still on the 1.0.0-rc4 ISO's build says 1.0.0-rc4, with its build on a line of its own, in ${look}`, async () => {
    const page = await tv(await box(BUILD, "edge", RC4), look);
    assert.deepEqual(await system(page), { about: "OrigaiTV 1.0.0-rc4", build: `Build ${BUILD}` });
    assert.deepEqual(await about(page), { big: "OrigaiTV 1.0.0-rc4", build: `Build ${BUILD}` });
    await fits(page);
    await page.close();
  });

  test(`T30.3 once updated past that build, it says Edge channel, installed from 1.0.0-rc4, with the new build under it, in ${look}`, async () => {
    const page = await tv(await box(LATER, "edge", RC4), look);
    assert.deepEqual(await system(page), { about: "Edge channel, installed from 1.0.0-rc4", build: `Build ${LATER}` });
    assert.deepEqual(await about(page), { big: "Edge channel, installed from 1.0.0-rc4", build: `Build ${LATER}` });
    await fits(page);
    await page.close();
  });

  test(`T30.3 the longer line fits at the larger size too, in ${look}`, async () => {
    const page = await tv(await box(LATER, "edge", RC4), look, "larger");
    assert.deepEqual(await system(page), { about: "Edge channel, installed from 1.0.0-rc4", build: `Build ${LATER}` });
    await fits(page);
    await page.close();
  });
}

test("a TV with the one-line file from before says its release, with its build under it", async () => {
  const page = await tv(await box(LATER, "edge", "1.0.0-rc4\n"), "glass");
  assert.deepEqual(await system(page), { about: "OrigaiTV 1.0.0-rc4", build: `Build ${LATER}` });
  await page.close();
});

test("T30.3 a stable TV says its release, and no build", async () => {
  const page = await tv(await box("1.0.0", "stable", RC4), "glass");
  assert.deepEqual(await system(page), { about: "OrigaiTV 1.0.0", build: null });
  assert.deepEqual(await about(page), { big: "OrigaiTV 1.0.0", build: null });
  await page.close();
});

test("an edge TV with no release, on a build that counts from a candidate, names the candidate the way it's written", async () => {
  const build = "1.0.0rc6.r12.g91b63a2e0";
  const page = await tv(await box(build, "edge"), "glass");
  assert.deepEqual(await system(page), { about: "OrigaiTV 1.0.0-rc6", build: `Build ${build}` });
  assert.deepEqual(await about(page), { big: "OrigaiTV 1.0.0-rc6", build: `Build ${build}` });
  await page.close();
});

test("T30.3 the 1.0.0-rc7 ISO's TV says 1.0.0-rc7, with the build named after rc6 under it", async () => {
  const build = "1.0.0rc6.r12.g91b63a2e0";
  const page = await tv(await box(build, "edge", `1.0.0-rc7\n${build}\n`), "terminal");
  assert.deepEqual(await system(page), { about: "OrigaiTV 1.0.0-rc7", build: `Build ${build}` });
  await fits(page);
  await page.close();
});

test("an edge TV with no release says its build, as it did before", async () => {
  const page = await tv(await box(BUILD, "edge"), "glass");
  assert.deepEqual(await system(page), { about: "OrigaiTV 0.2.0", build: `Build ${BUILD}` });
  assert.deepEqual(await about(page), { big: "OrigaiTV 0.2.0", build: `Build ${BUILD}` });
  await page.close();
});
