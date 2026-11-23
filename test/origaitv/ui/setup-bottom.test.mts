// Room at the bottom of setup's screens (T30.7), at 1920 × 1080 and on a
// 4K TV at 3840 × 2160. On the NUC, a new profile's Add sat on the
// soundtrack's player, Pick a look's sizes ran into the status bar, and the
// bar's status wrapped onto two lines next to "11 of 12 · theme and
// background". Here nothing a person can press overlaps the player or comes
// within 24 px of the bar, and the bar is one line, with the status Radomir
// saw: Claude ready and three games that didn't install, each by its name.
// That's longer than the bar has room for, so the bar cuts it short at its
// end, and what didn't work comes first.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { OFFICIAL, startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const TV = { output: "HDMI-A-1", modes: ["3840x2160@60.00Hz", "1920x1080@60.00Hz"], live: { mode: "3840x2160@60", scale: 2 } };
const STEPS = ["welcome", "ready", "country", "ai", "people", "goal", "apps", "look", "theme", "background"];
const FAILED = { "origaitv.steam": { state: "failed" }, "origaitv.battlenet": { state: "failed" }, "origaitv.retroarch": { state: "failed" } };
// Battle.net and RetroArch in the app list too, so setup knows their names.
const CATALOG = [
  ...OFFICIAL,
  ...[
    { id: "origaitv.battlenet", name: "Battle.net", description: "Blizzard's games on the TV" },
    { id: "origaitv.retroarch", name: "RetroArch", description: "Older consoles' games on the TV" },
  ].map((app) => ({ ...OFFICIAL[0], ...app, path: `apps/${app.id.replace("origaitv.", "")}` })),
];
const NAMED = "Couldn't install Steam, Battle.net and RetroArch";

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state } = await startBox(0, undefined, { features: { setup2: true, looks: true, sizes: true }, catalog: CATALOG }));
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
  await page.waitForFunction(() => /couldn't/i.test(document.querySelector(".bar-info")?.textContent ?? ""));
  return page;
}

// Whether the start of the bar's status shows in full, however the rest of
// it is cut short.
function startShows(page: Page, start: string): Promise<boolean> {
  return page.evaluate((start) => {
    const el = document.querySelector(".bar-info") as HTMLElement;
    if (!el.textContent?.startsWith(start)) return false;
    const probe = el.cloneNode(false) as HTMLElement;
    probe.textContent = start;
    probe.style.cssText = "position: absolute; visibility: hidden; overflow: visible; width: auto";
    el.after(probe);
    const fits = probe.scrollWidth <= el.clientWidth;
    probe.remove();
    return fits;
  }, start);
}

// What's wrong at the bottom: anything to press, or the sizes, that
// overlaps the player or comes within 24 px of the bar, in the canvas's own
// pixels; and a bar that isn't one line, or whose step or clock is cut
// short. The status may be cut at its end: startShows checks its start.
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
      // One line's height, from a copy of the element with one letter in it
      // that can't wrap, beside it in the same bar.
      const probe = el.cloneNode(false) as HTMLElement;
      probe.textContent = "X";
      probe.style.whiteSpace = "nowrap";
      el.after(probe);
      const one = probe.getBoundingClientRect().height;
      probe.remove();
      const lines = Math.round(el.getBoundingClientRect().height / one);
      if (lines !== 1) said.push(`${part} is ${lines} lines: "${el.textContent}"`);
      if (part !== ".bar-info" && el.scrollWidth > el.clientWidth + 1) said.push(`${part} is cut short: "${el.textContent}"`);
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
      await page.waitForFunction((named) => document.querySelector(".bar-info")?.textContent === named, NAMED);
      assert.deepEqual(await crowded(page), []);
      assert.ok(await startShows(page, "Couldn't install Steam"), "the start of what didn't install shows");
    } finally {
      await page.close();
    }
  });
}

for (const size of [
  [1920, 1080],
  [3840, 2160],
] as [number, number][]) {
  test(`T30.7 at ${size[0]}×${size[1]}, the longest status stays one line next to the longest step, and what didn't work shows first`, async () => {
    await fetch(`${url}/api/ai/cli`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "failed", error: "the download stopped" }) });
    const page = await at("theme", size);
    try {
      // Claude and three games that didn't set up: one sentence, cut short
      // at its end.
      await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Couldn't set up Claude or Steam, Battle.net and RetroArch");
      assert.equal(await page.locator(".bar-step").textContent(), "11 of 12 · theme and background");
      assert.deepEqual(await crowded(page), []);
      assert.ok(await startShows(page, "Couldn't set up Claude or Steam"), "what didn't work shows first");
      // Something under way comes after what didn't work.
      await fetch(`${url}/api/ai/cli`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "installing" }) });
      await page.waitForFunction((named) => document.querySelector(".bar-info")?.textContent === `${named} · Setting up Claude…`, NAMED);
      assert.deepEqual(await crowded(page), []);
      assert.ok(await startShows(page, "Couldn't install Steam"), "what didn't work shows first");
    } finally {
      await page.close();
      await fetch(`${url}/api/ai/cli`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "ready", version: "2.1.30 (Claude Code)" }) });
    }
  });
}

test("T30.7 the bar names one app that didn't install, and says Claude is ready when nothing else needs saying", async () => {
  const page = await at("theme", [1920, 1080]);
  try {
    (daemon as unknown as { broadcast(event: string, data: unknown): void }).broadcast("setup-apps", { "origaitv.steam": { state: "failed" } });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Couldn't install Steam");
    assert.deepEqual(await crowded(page), []);
    (daemon as unknown as { broadcast(event: string, data: unknown): void }).broadcast("setup-apps", { "origaitv.steam": { state: "installed" } });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Claude is ready");
  } finally {
    await page.close();
  }
});

test("T30.7 the bar says why the apps didn't install, after which ones, and the reason shows in full for one", async () => {
  const said = (apps: Record<string, unknown>) => (daemon as unknown as { broadcast(event: string, data: unknown): void }).broadcast("setup-apps", apps);
  const update = (name: string) => ({ state: "failed", error: `Couldn't install ${name}. Update your TV in Settings, under Updates, then try again.` });
  // On Pick a look, one game with the TV's reason fits on one line, in
  // full.
  let page = await at("look", [1920, 1080]);
  try {
    said({ "origaitv.steam": update("Steam") });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Couldn't install Steam. Update your TV");
    assert.deepEqual(await crowded(page), []);
    assert.ok(await startShows(page, "Couldn't install Steam. Update your TV"), "the reason shows in full");
    // Offline, it says to check the internet.
    said({ "origaitv.steam": { state: "failed", error: "Couldn't download Steam. Check your internet, then try again." } });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Couldn't install Steam. Check your internet");
    assert.ok(await startShows(page, "Couldn't install Steam. Check your internet"), "the reason shows in full");
  } finally {
    await page.close();
  }
  // On Pick a theme, next to the longest step: three for the same reason,
  // which ones first, then why, cut short as it must be.
  page = await at("theme", [1920, 1080]);
  try {
    said({ "origaitv.steam": update("Steam"), "origaitv.battlenet": update("Battle.net"), "origaitv.retroarch": update("RetroArch") });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Couldn't install Steam, Battle.net and RetroArch. Update your TV");
    assert.deepEqual(await crowded(page), []);
    assert.ok(await startShows(page, "Couldn't install Steam"), "what didn't install shows first");
    // Two reasons: no reason given, rather than the wrong one.
    said({ "origaitv.steam": update("Steam"), "origaitv.retroarch": { state: "failed", error: "Couldn't download RetroArch. Check your internet, then try again." } });
    await page.waitForFunction(() => document.querySelector(".bar-info")?.textContent === "Couldn't install Steam and RetroArch");
  } finally {
    await page.close();
  }
});
