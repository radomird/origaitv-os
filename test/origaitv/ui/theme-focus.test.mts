// Pick a theme's focus (T30.8), with setup's own switch on, at 1920 × 1080
// and 3840 × 2160. On the NUC the focus box sat tight on a theme's picture,
// and picking a theme threw the focus down to the backgrounds. Here the box
// has room round the picture, and a theme picked keeps the focus until down
// moves it to the backgrounds.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const STEPS = ["welcome", "ready", "country", "ai", "people", "goal", "apps", "look", "theme", "background"];

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
const errors: string[] = [];
// The themes the TV was asked to use, through the screen daemon's binding.
const asked: string[] = [];

before(async () => {
  ({ daemon, url, state } = await startBox(0, undefined, { features: { setup2: true, looks: true } }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function atTheme(size: [number, number]): Promise<Page> {
  const now = new Date().toISOString();
  const finished = Object.fromEntries(STEPS.slice(0, STEPS.indexOf("theme")).map((s) => [s, now]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "theme", finished, goal: "streaming" }));
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("origaitvAsked", (json: string) => asked.push(json));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void; origaitvAsked: (json: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.origaitvAsked(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".theme2 .tb-theme.focused");
  await page.mouse.move(1, 1);
  return page;
}

// How much room the focus box leaves round the picture of the theme with
// the focus, on each side, in the canvas's own pixels: from the inside of
// the ring's border to the picture's edge.
async function room(page: Page): Promise<number[]> {
  // The ring glides there.
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const zoom = Number(document.documentElement.style.zoom) || 1;
    const ring = document.getElementById("ring")!;
    const border = parseFloat(getComputedStyle(ring).borderTopWidth);
    const r = ring.getBoundingClientRect();
    const f = document.querySelector(".tb-theme.focused .look-frame")!.getBoundingClientRect();
    return [f.left - r.left, f.top - r.top, r.right - f.right, r.bottom - f.bottom].map((side) => Math.round(side / zoom - border));
  });
}

for (const size of [
  [1920, 1080],
  [3840, 2160],
] as [number, number][]) {
  test(`T30.8 at ${size[0]}×${size[1]}, the focus box has room round a theme's picture`, async () => {
    const page = await atTheme(size);
    try {
      for (const side of await room(page)) assert.ok(side >= 8, `at least 8 px of room on each side: ${await room(page)}`);
      await page.keyboard.press("ArrowRight");
      for (const side of await room(page)) assert.ok(side >= 8, `and on the next one too: ${await room(page)}`);
    } finally {
      await page.close();
    }
  });
}

test("T30.8 picking a theme leaves the focus on it, and down moves it to the backgrounds", async () => {
  const page = await atTheme([1920, 1080]);
  try {
    await page.keyboard.press("ArrowRight");
    const next = await page.locator(".tb-theme.focused").getAttribute("data-theme");
    assert.ok(next);
    await page.keyboard.press("Enter");
    await page.waitForSelector(`.tb-theme.picked[data-theme="${next}"]`);
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".focused").getAttribute("data-theme"), next, "the focus stays on the theme picked");
    assert.ok(asked.some((json) => json.includes(next!)), "the TV was asked to use it");
    // OK again on the theme in use leaves the focus there too.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".focused").getAttribute("data-theme"), next);
    await page.keyboard.press("ArrowDown");
    assert.ok(await page.locator(".focused").getAttribute("data-background"), "down is the backgrounds");
  } finally {
    await page.close();
  }
});
