// Fit to screen keeps every press, in a real Chromium. Each step is saved
// at once, and each save says the display changed, which draws the page
// again. Here the stand-in for the TV session takes a while to set each
// step, as a real one can, so the saves trail the presses: a held key, and
// quick presses the other way. The size on screen never jumps back, and the
// margin the TV keeps is where the presses ended.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { FIXTURES, rest, startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

// A 4K TV, which offers all three sizes.
const TV = { output: "HDMI-A-1", modes: ["3840x2160@60.00Hz", "1920x1080@60.00Hz"], live: { mode: "3840x2160@60", scale: 2 } };
// How long the stand-in takes to set each step.
const SET_MS = 120;

let browser: Browser;
let daemon: Daemon;
let url = "";
let screenDaemon = true;
const errors: string[] = [];

// The screen daemon's side: it takes each ask, takes its time, and says the
// TV runs at it, margin and all.
async function standInScreen(): Promise<void> {
  while (screenDaemon) {
    const said = (await (await fetch(`${url}/api/display/ask`).catch(() => null))?.json().catch(() => null)) as {
      ask?: { n: number; target: { mode: string; scale: number; reserved: [number, number] } } | null;
    } | null;
    const ask = said?.ask;
    if (!ask) continue;
    await new Promise((done) => setTimeout(done, SET_MS));
    await fetch(`${url}/api/display/ask/${ask.n}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, live: { mode: ask.target.mode, scale: ask.target.scale, reserved: ask.target.reserved } }),
    });
  }
}

before(async () => {
  ({ daemon, url } = await startBox(0, FIXTURES, { builtins: true, zone: "Europe/Amsterdam", features: { looks: true, sizes: true } }));
  await fetch(`${url}/api/display/tv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(TV) });
  void standInScreen();
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  screenDaemon = false;
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

const margin = async () => ((await (await fetch(`${url}/api/display`)).json()) as { margin: number }).margin;

// The margin the TV has kept, once the last save has landed.
async function kept(want: number): Promise<number> {
  const end = Date.now() + 5000;
  let now = await margin();
  while (now !== want && Date.now() < end) {
    await new Promise((done) => setTimeout(done, 100));
    now = await margin();
  }
  return now;
}

async function fitScreen(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector("#page .focused");
  await rest(page);
  await page.evaluate(() => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go("fit"));
  await page.waitForSelector(".fit-screen .fit-size.focused");
  // Every size the page shows, in order, whichever page it's on.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    const look = () => {
      const now = document.querySelector(".fit-value")?.textContent ?? "";
      if (now && now !== seen.at(-1)) seen.push(now);
    };
    look();
    new MutationObserver(look).observe(document.getElementById("page")!, { subtree: true, childList: true, characterData: true });
  });
  return page;
}

// The sizes shown, as percents, "Whole screen" being 100.
const seen = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).map((text) => (text === "Whole screen" ? 100 : Number.parseInt(text, 10)));

const put = (body: unknown) => fetch(`${url}/api/display`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Fit to screen: right held down goes up a step each repeat, never back, and the TV keeps where it stopped", async () => {
  await put({ size: "standard", margin: 4 });
  const page = await fitScreen();
  try {
    assert.deepEqual(await seen(page), [92]);
    // About 40 repeats a second, as on the TV, for eight steps.
    await page.keyboard.down("ArrowRight");
    for (let i = 0; i < 7; i++) {
      await page.waitForTimeout(25);
      await page.keyboard.down("ArrowRight");
    }
    await page.keyboard.up("ArrowRight");
    await page.waitForFunction(() => document.querySelector(".fit-value")?.textContent === "Whole screen");
    assert.equal(await kept(0), 0, "the TV keeps no margin");
    await page.waitForTimeout(SET_MS * 3);
    assert.equal(await page.locator(".fit-value").textContent(), "Whole screen", "and the page still says so");
    assert.deepEqual(await seen(page), [92, 93, 94, 95, 96, 97, 98, 99, 100]);
  } finally {
    await page.close();
  }
});

test("Fit to screen: quick presses of left each take a step, never back, and the TV keeps where they ended", async () => {
  await put({ size: "standard", margin: 0 });
  const page = await fitScreen();
  try {
    // Each a little quicker than the TV sets a step, so the saves trail
    // further behind with each press.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(SET_MS / 2 + Math.random() * 20);
    }
    await page.waitForFunction(() => document.querySelector(".fit-value")?.textContent === "90%");
    assert.equal(await kept(5), 5, "the TV keeps 5 percent each side");
    await page.waitForTimeout(SET_MS * 3);
    assert.equal(await page.locator(".fit-value").textContent(), "90%", "and the page still says so");
    assert.deepEqual(await seen(page), [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90]);
  } finally {
    await page.close();
  }
});
