// Getting ready installs the system's own updates too, with setup's own
// switch on. A fresh box from an older stick can find its mirror has moved
// on since the stick was made: then only OrigaiTV being up to date isn't
// enough, and the games picked later won't install. Here the check finds
// system updates and nothing newer of OrigaiTV's, and setup runs the TV's
// own update, waits for it to say it's done (OrigaiTV's version doesn't
// change, so that can't be the sign), and comes back from the restart a new
// kernel takes, told by the box's boot rather than by any clock. An update
// that fails says why, one that stops giving news counts as failed after
// the daemon's 15 minutes, one that failed after a new kernel asks for a
// restart, and the nightly run's hold carries on and says so.

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
// The box's boot, which a restart changes.
const BOOTS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
let boot = BOOTS[0];

before(async () => {
  ({ daemon, url, state, updates } = await startBox(0, undefined, { features: { setup2: true }, bootId: () => boot }));
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
  boot = BOOTS[0];
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "ready", finished: { welcome: "2026-11-05T10:00:00Z" } }));
  rmSync(join(updates, "progress.json"), { force: true });
  rmSync(join(updates, "status.json"), { force: true });
}

// The TV's page. With a clock, the page's own clock is one the test moves
// on, set to the time given.
async function tv(clock?: Date): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  if (clock) await page.clock.install({ time: clock });
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
const bar = (page: Page) => page.locator(".bar-info").textContent();
const says = (page: Page, text: string) => page.waitForFunction((t) => document.querySelector(".setup-line")?.textContent === t, text, { timeout: 10_000 });
const movesOn = (page: Page) => page.waitForFunction(() => (window as unknown as { origaitvSetup: { route(): string } }).origaitvSetup.route() !== "ready", null, { timeout: 10_000 });

// What the update check says: system updates waiting, and nothing newer of
// OrigaiTV's or Omarchy's.
// With the nightly run's hold, they wait for it.
async function systemUpdates(waiting = false): Promise<void> {
  const version = await running();
  writeFileSync(join(updates, "status.json"), JSON.stringify({ checked_at: now(), ok: true, channel: "stable", origaitv: { installed: version, available: null }, omarchy: { installed: "4.5.0-1", available: null }, packages: 12, waiting, security: false, notes: { origaitv: [], origaitv_date: null, omarchy: [] } }));
  return;
}

function progress(state: string, step: string, percent: number, at = now(), more: object = {}): void {
  writeFileSync(join(updates, "progress.json"), JSON.stringify({ state, step, percent, detail: "", at, from: { origaitv: "x", omarchy: "4.5.0-1" }, to: { origaitv: "x" }, ...more }));
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

test("getting ready comes back from the restart a new kernel takes, told by the box's boot, with the browser's clock behind", async () => {
  atReady();
  let page = await tv();
  try {
    await asked(page, "update-check");
    await systemUpdates();
    await asked(page, "update-install");
    // The update installed a new kernel: it says so, and the TV restarts.
    progress("restarting", "restart", 98);
    await says(page, "Restarting your TV…");
  } finally {
    await page.close();
  }
  // The page loads again in the seconds before the restart, on the same
  // boot: still restarting, not done.
  page = await tv();
  try {
    await says(page, "Restarting your TV…");
    await page.waitForTimeout(2500);
    assert.equal((await step()).ready.update, "installing", "not done before the TV has restarted");
  } finally {
    await page.close();
  }
  // The TV is back on another boot, its clock an hour behind the time the
  // update wrote, as before the network sets it right: setup's page loads
  // again, and carries on.
  boot = BOOTS[1];
  page = await tv(new Date(Date.now() - 3_600_000));
  try {
    await movesOn(page);
    assert.equal((await step()).ready.update, "done");
  } finally {
    await page.close();
  }
});

test("an update that stops giving news counts as failed after 15 minutes, says so, and setup carries on", async () => {
  atReady();
  const page = await tv(new Date());
  try {
    await asked(page, "update-check");
    await systemUpdates();
    await asked(page, "update-install");
    // The update never says anything: its service didn't start.
    await says(page, "Updating your TV. It can take a few minutes and restart once.");
    await page.clock.fastForward("14:00");
    await page.waitForTimeout(1500);
    assert.equal((await step()).ready.update, "installing", "still updating before the 15 minutes");
    await page.clock.fastForward("01:30");
    await says(page, "The update stopped answering. Try again in Settings.");
    assert.match((await bar(page)) ?? "", /^Update stopped answering/);
    assert.equal((await step()).ready.why, "stalled");
    await page.clock.fastForward("00:03");
    await movesOn(page);
  } finally {
    await page.close();
  }
});

test("an update that failed says why, on the line and in the bar, and setup carries on", async () => {
  atReady();
  const page = await tv();
  try {
    await asked(page, "update-check");
    await systemUpdates();
    await asked(page, "update-install");
    progress("failed", "packages", 0, now(), { detail: "nothing changed", reason: "offline" });
    await says(page, "Couldn't update. Your TV isn't online.");
    assert.match((await bar(page)) ?? "", /^Not online/);
    assert.equal((await step()).ready.why, "offline");
    await movesOn(page);
  } finally {
    await page.close();
  }
});

test("an update that failed after a new kernel went in asks for a restart, OK restarts the TV, and setup carries on after", async () => {
  atReady();
  let page = await tv();
  try {
    await asked(page, "update-check");
    await systemUpdates();
    await asked(page, "update-install");
    progress("failed", "packages", 0, now(), { detail: "the update stopped halfway", reason: "halfway", restart: true });
    await says(page, "Your TV needs a restart to finish updating.");
    assert.match((await bar(page)) ?? "", /^Press OK to restart/);
    // It doesn't move on by itself.
    await page.waitForTimeout(3000);
    assert.equal(await page.evaluate(() => (window as unknown as { origaitvSetup: { route(): string } }).origaitvSetup.route()), "ready");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as unknown as { screenRequests: { cmd: string; what?: string }[] }).screenRequests.some((r) => r.cmd === "power" && r.what === "restart"));
  } finally {
    await page.close();
  }
  // Back on another boot, setup carries on.
  boot = BOOTS[1];
  page = await tv();
  try {
    await movesOn(page);
    assert.equal((await step()).ready.update, "failed");
  } finally {
    await page.close();
  }
});

test("updates the nightly run hasn't passed yet aren't installed: setup says it's up to date for now, and carries on", async () => {
  atReady();
  const page = await tv();
  try {
    await asked(page, "update-check");
    await systemUpdates(true);
    await says(page, "Your TV is up to date for now. Newer updates come later.");
    assert.match((await bar(page)) ?? "", /^Some updates aren't ready yet/);
    await movesOn(page);
    const requests = await page.evaluate(() => (window as unknown as { screenRequests: { cmd: string }[] }).screenRequests.map((r) => r.cmd));
    assert.ok(!requests.includes("update-install"), "nothing is installed");
    assert.deepEqual([(await step()).ready.update, (await step()).ready.why], ["none", "waiting"]);
  } finally {
    await page.close();
  }
});
