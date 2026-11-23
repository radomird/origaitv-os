// Getting ready installs the system's own updates too, with setup's own
// switch on. A fresh box from an older stick can find its mirror has moved
// on since the stick was made: then only OrigaiTV being up to date isn't
// enough, and the games picked later won't install. Here the check finds
// system updates and nothing newer of OrigaiTV's, and setup runs the TV's
// own update, waits for it to say it's done (OrigaiTV's version doesn't
// change, so that can't be the sign), and comes back from the restart a new
// kernel takes.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let updates = "";
const errors: string[] = [];

before(async () => {
  ({ daemon, url, state, updates } = await startBox(0, undefined, { features: { setup2: true } }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  assert.deepEqual(errors, []);
});

const now = () => new Date().toISOString();
const running = async () => (await (await fetch(`${url}/api/setup`)).json()).running as string;
const step = async () => (await (await fetch(`${url}/api/setup`)).json()).setup;

function atReady(): void {
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "ready", finished: { welcome: "2026-11-05T10:00:00Z" } }));
  rmSync(join(updates, "progress.json"), { force: true });
  rmSync(join(updates, "status.json"), { force: true });
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { screenRequests: { cmd: string }[]; origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.screenRequests = [];
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      w.screenRequests.push(request);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".ready2");
  return page;
}

const asked = (page: Page, cmd: string) => page.waitForFunction((c) => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.some((r) => r.cmd === c), cmd, { timeout: 10_000 });
const line = (page: Page) => page.locator(".setup-line").textContent();

// What the update check says: system updates waiting, and nothing newer of
// OrigaiTV's or Omarchy's.
async function systemUpdates(): Promise<void> {
  const version = await running();
  writeFileSync(join(updates, "status.json"), JSON.stringify({ checked_at: now(), ok: true, channel: "stable", origaitv: { installed: version, available: null }, omarchy: { installed: "4.5.0-1", available: null }, packages: 12, security: false, notes: { origaitv: [], origaitv_date: null, omarchy: [] } }));
  return;
}

function progress(state: string, step: string, percent: number, at = now()): void {
  writeFileSync(join(updates, "progress.json"), JSON.stringify({ state, step, percent, detail: "", at, from: { origaitv: "x", omarchy: "4.5.0-1" }, to: { origaitv: "x" } }));
}

test("getting ready installs the system's own updates, says it can take a few minutes and restart, and moves on once the update says it's done", async () => {
  atReady();
  const page = await tv();
  try {
    await asked(page, "update-check");
    await systemUpdates();
    await asked(page, "update-install");
    await page.waitForFunction(() => document.querySelector(".setup-line")?.textContent === "Updating your TV. It can take a few minutes and restart once.");
    progress("running", "packages", 40);
    await page.waitForFunction(() => document.querySelector(".blocks")?.getAttribute("aria-label") === "40 percent");
    // OrigaiTV's version is the same as before, and that isn't the sign it's
    // done: it stays on, updating.
    await page.waitForTimeout(2500);
    assert.equal((await step()).ready.update, "installing");
    assert.equal(await line(page), "Updating your TV. It can take a few minutes and restart once.");
    // Done: up to date, and on to the next step by itself.
    progress("done", "restart", 100);
    await page.waitForFunction(() => document.querySelector(".setup-line")?.textContent === "Your TV is up to date");
    await page.waitForFunction(() => (window as unknown as { origaitvSetup: { route(): string } }).origaitvSetup.route() !== "ready", null, { timeout: 10_000 });
    assert.equal((await step()).ready.update, "done");
  } finally {
    await page.close();
  }
});

test("getting ready comes back from the restart a new kernel takes, and moves on", async () => {
  atReady();
  let page = await tv();
  try {
    await asked(page, "update-check");
    await systemUpdates();
    await asked(page, "update-install");
    // The update installed a new kernel: it says so, and the TV restarts.
    progress("restarting", "restart", 98);
    await page.waitForFunction(() => document.querySelector(".setup-line")?.textContent === "Restarting your TV…");
  } finally {
    await page.close();
  }
  // The TV is back, with the update still saying it was restarting: setup's
  // page loads again, and carries on.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  page = await tv();
  try {
    await page.waitForFunction(() => (window as unknown as { origaitvSetup: { route(): string } }).origaitvSetup.route() !== "ready", null, { timeout: 10_000 });
    assert.equal((await step()).ready.update, "done");
  } finally {
    await page.close();
  }
});
