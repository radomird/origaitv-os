// Room at the bottom of setup's screens (T30.7), at 1920 × 1080 and on a
// 4K TV at 3840 × 2160. On the NUC, a new profile's Add sat on the
// soundtrack's player, Pick a look's sizes ran into the status bar, and the
// bar's status wrapped onto two lines next to "11 of 12 · theme and
// background". Here nothing a person can press overlaps the player or comes
// within 24 px of the bar, and the bar is one line, with the status Radomir
// saw: Claude ready and three games that didn't install.

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

const TV = { output: "HDMI-A-1", modes: ["3840x2160@60.00Hz", "1920x1080@60.00Hz"], live: { mode: "3840x2160@60", scale: 2 } };
const STEPS = ["welcome", "ready", "country", "ai", "people", "goal", "apps", "look", "theme", "background"];
const FAILED = { "origaitv.steam": { state: "failed" }, "origaitv.battlenet": { state: "failed" }, "origaitv.retroarch": { state: "failed" } };

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state } = await startBox(0, undefined, { features: { setup2: true, looks: true, sizes: true } }));
  await fetch(`${url}/api/display/tv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(TV) });
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Claude's plan, its terms accepted and its tool in, as on the NUC.
  await post("/api/ai", { provider: "claude", path: "plan" });
  await daemon.ai.accept("claude", "plan", { phone: "iphone", viewer: "radomir" });
  await post("/api/ai/cli", { state: "ready", version: "2.1.30 (Claude Code)" });
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

async function at(step: string, size: [number, number]): Promise<Page> {
  const now = new Date().toISOString();
  const finished = Object.fromEntries(STEPS.slice(0, STEPS.indexOf(step)).map((s) => [s, now]));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step, finished, goal: "streaming" }));
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector("#page .focused");
  await page.mouse.move(1, 1);
  // The three games that didn't install, as the TV says so to setup.
  (daemon as unknown as { broadcast(event: string, data: unknown): void }).broadcast("setup-apps", FAILED);
  await page.waitForFunction(() => /install/i.test(document.querySelector(".bar-info")?.textContent ?? ""));
  return page;
}

// What's wrong at the bottom: anything to press, or the sizes, that
// overlaps the player or comes within 24 px of the bar, in the canvas's own
// pixels; and a bar that isn't one line, or whose status is cut short.
async function crowded(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const zoom = Number(document.documentElement.style.zoom) || 1;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left / zoom, top: r.top / zoom, right: r.right / zoom, bottom: r.bottom / zoom, height: r.height / zoom };
    };
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
    const said: string[] = [];
    const player = document.querySelector(".player");
    const bar = document.querySelector(".bar")!;
    const barTop = box(bar).top;
    const pressable = [...document.querySelectorAll("#page .setup-page [data-focus], #page .setup-look-sizes")].filter((el) => (el as HTMLElement).offsetParent !== null);
    for (const el of pressable) {
      const at = box(el);
      if (at.bottom > barTop - 24) said.push(`${name(el)} ends ${Math.round(barTop - at.bottom)} px above the bar`);
      if (player) {
        const p = box(player);
        if (at.left < p.right && at.right > p.left && at.top < p.bottom && at.bottom > p.top) said.push(`${name(el)} overlaps the soundtrack's player`);
      }
    }
    for (const part of [".bar-step", ".bar-info", ".bar-clock"]) {
      const el = document.querySelector(part) as HTMLElement | null;
      if (!el) continue;
      const lines = Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || "0"));
      if (el.getClientRects().length !== 1 || lines > 1) said.push(`${part} is on more than one line: "${el.textContent}"`);
      if (el.scrollWidth > el.clientWidth + 1) said.push(`${part} is cut short: "${el.textContent}"`);
    }
    return said;
  });
}

for (const size of [
  [1920, 1080],
  [3840, 2160],
] as [number, number][]) {
  const where = `${size[0]}×${size[1]}`;

  test(`T30.7 at ${where}, Who's watching and a new profile leave room at the bottom, and the bar is one line`, async () => {
    const page = await at("people", size);
    try {
      assert.deepEqual(await crowded(page), []);
      // A new profile: its Add sits beside the form, clear of the player.
      await page.locator('[data-action="add"]').click();
      await page.waitForSelector(".person2 [data-action=save]");
      await page.mouse.move(1, 1);
      assert.deepEqual(await crowded(page), []);
    } finally {
      await page.close();
    }
  });

  test(`T30.7 at ${where}, Pick a look's sizes keep clear of the bar, and the bar is one line`, async () => {
    const page = await at("look", size);
    try {
      await page.waitForSelector(".setup-look-sizes .chip");
      assert.deepEqual(await crowded(page), []);
    } finally {
      await page.close();
    }
  });

  test(`T30.7 at ${where}, Pick a theme's bar says what didn't install on one line, next to the step`, async () => {
    const page = await at("theme", size);
    try {
      assert.deepEqual(await crowded(page), []);
      assert.equal(await page.locator(".bar-step").textContent(), "11 of 12 · theme and background");
      assert.equal(await page.locator(".bar-info").textContent(), "Couldn't install 3 apps");
    } finally {
      await page.close();
    }
  });
}

test("T30.7 the bar names one app that didn't install, and says Claude is ready when nothing else needs saying", async () => {
  const page = await at("theme", [1920, 1080]);
  try {
    (daemon as unknown as { broadcast(event: string, data: unknown): void }).broadcast("setup-apps", { "origaitv.steam": { state: "failed" } });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Couldn't install steam");
    (daemon as unknown as { broadcast(event: string, data: unknown): void }).broadcast("setup-apps", { "origaitv.steam": { state: "installed" } });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Claude is ready");
  } finally {
    await page.close();
  }
});
