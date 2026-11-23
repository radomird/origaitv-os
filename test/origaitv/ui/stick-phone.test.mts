// The phone that installed the TV from the USB stick, in a real Chromium
// (ADR-019, layer 4): setup's welcome screen at 1920 × 1080 shows no code
// for it to scan. While the TV is on its own Wi-Fi, the phone pairs there
// with the stick's secret, and the screen asks for the home Wi-Fi on that
// phone. Once the TV is online, setup moves on by itself. If the phone
// never comes, the code shows after a while, as it always has. The stick
// and first boot are the image layer's.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";
import { pairPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let state = "";
let hotspot = "";
let online = false;
const errors: string[] = [];
const tools = mkdtempSync(join(tmpdir(), "origaitv-stick-phone-ui-"));
const path = process.env.PATH;
const secret = randomBytes(16).toString("base64url");

before(async () => {
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect width="21" height="21"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  const wired = { eth0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }] };
  ({ daemon, url, state, hotspot } = await startBox(0, undefined, { interfaces: () => (online ? wired : {}) }));
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER, args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  process.env.PATH = path;
  rmSync(tools, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

const post = (to: string, body: unknown) => fetch(`${url}${to}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function hotspotIs(fields: Record<string, unknown>): void {
  writeFileSync(join(hotspot, "state.json"), JSON.stringify({ on: false, ssid: "OrigaiTV-3f9a", password: "k7m2xpqr4n", ...fields }));
}

// Setup from the start, with the stick's secret handed over, as first boot
// leaves it.
async function fresh(): Promise<void> {
  await post("/api/setup", { done: false });
  writeFileSync(join(state, "stick-pairing.json"), JSON.stringify({ secret }), { mode: 0o600 });
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForFunction(() => (window as unknown as { origaitvWelcome?: boolean }).origaitvWelcome === true);
  await page.waitForSelector(".welcome");
  return page;
}

const line = (page: Page, text: string) => page.waitForFunction((t) => document.querySelector(".welcome-line")?.textContent === t, text, { timeout: 8000 });

test("T30.2 the stick's phone pairs on the TV's own Wi-Fi with no code shown, picks the home Wi-Fi, and setup moves on once the TV is online", async () => {
  online = false;
  await fresh();
  hotspotIs({ on: true });
  const page = await tv();
  // The TV opened the stick's Wi-Fi again, and the phone rejoins it by
  // itself: no Wi-Fi code and no pairing code to scan meanwhile.
  await line(page, "Waiting for your phone…");
  assert.ok(await page.locator(".welcome-qr.away").count(), "no code to scan");
  assert.equal((await (await fetch(`${url}/api/phones`)).json()).pairing, null, "no pairing code on show");

  // The phone is back on the TV's Wi-Fi and pairs with the stick's secret.
  await pairPhone(`http://127.0.0.1:${daemon.lanPort}`, { secret }, "Ana's iPhone");
  await line(page, "Pick your Wi-Fi on your phone");
  assert.ok(await page.locator(".welcome-qr.away").count(), "no code to scan");
  assert.match(await page.locator(".bar").innerText(), /ana's iphone paired/i);

  hotspotIs({ on: false, joining: "home wi-fi" });
  await line(page, "Joining home wi-fi…");

  // Online: it says so, and moves on with no press.
  hotspotIs({ on: false, joined: { ssid: "home wi-fi", address: "127.0.0.1" } });
  online = true;
  await line(page, "Ana's iPhone is paired");
  await page.waitForFunction(() => !document.querySelector(".welcome"), null, { timeout: 8000 });
  const setup = (await (await fetch(`${url}/api/setup`)).json()).setup;
  assert.equal(setup.keyboard, false);
  assert.notEqual(setup.step, "welcome");
  assert.equal((await (await fetch(`${url}/api/phones`)).json()).pairing, null, "no code was ever shown");
  await page.close();
});

test("T30.2 on a cable the screen waits for the stick's phone with no code, and the phone pairing moves setup on", async () => {
  online = true;
  await fresh();
  hotspotIs({ on: false, ssid: null, password: null });
  const page = await tv();
  await line(page, "Waiting for your phone…");
  assert.ok(await page.locator(".welcome-qr.away").count(), "no code to scan");
  await page.waitForTimeout(2500);
  assert.equal((await (await fetch(`${url}/api/phones`)).json()).pairing, null, "still no code after a redraw");
  await pairPhone(`http://127.0.0.1:${daemon.lanPort}`, { secret }, "pixel");
  await line(page, "pixel is paired");
  await page.waitForFunction(() => !document.querySelector(".welcome"), null, { timeout: 8000 });
  await page.close();
});

// The page with its clock held, and its line read after each step of the
// clock, with time for the daemon's answers to come back.
async function heldClock(): Promise<{ page: Page; lineAfter: (ms: number) => Promise<string | null | undefined> }> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`${url}/`);
  await page.waitForFunction(() => (window as unknown as { origaitvWelcome?: boolean }).origaitvWelcome === true);
  await page.waitForSelector(".welcome");
  const lineAfter = async (ms: number) => {
    await page.clock.runFor(ms);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.clock.runFor(100);
    return page.evaluate(() => document.querySelector(".welcome-line")?.textContent);
  };
  return { page, lineAfter };
}

test("T30.2 on the TV's own Wi-Fi, if the stick's phone doesn't come, the Wi-Fi code shows after a couple of minutes", async () => {
  online = false;
  await fresh();
  hotspotIs({ on: true });
  const { page, lineAfter } = await heldClock();
  assert.equal(await lineAfter(4000), "Waiting for your phone…");
  assert.equal(await lineAfter(60_000), "Waiting for your phone…");
  await lineAfter(60_000 + 4000);
  assert.equal(await lineAfter(2000), "Scan the code with your phone");
  assert.match((await page.locator(".welcome-qr .qr").getAttribute("src")) ?? "", /^\/api\/hotspot\/qr/, "the Wi-Fi code is on show");
  await page.close();
});

test("T30.2 a Wi-Fi password that didn't work shows while the stick's phone is still to pair", async () => {
  online = false;
  await fresh();
  hotspotIs({ on: true, error: "that password didn't work for home wi-fi" });
  const page = await tv();
  await line(page, "that password didn't work for home wi-fi. Scan the code to try again.");
  await page.close();
});

test("T30.2 if the stick's phone doesn't come, the code shows after a couple of minutes", async () => {
  online = true;
  await fresh();
  hotspotIs({ on: false, ssid: null, password: null });
  const { page, lineAfter } = await heldClock();
  assert.equal(await lineAfter(4000), "Waiting for your phone…");
  assert.equal(await lineAfter(60_000), "Waiting for your phone…");
  await lineAfter(60_000 + 4000);
  // The earlier tests' phones are still paired, which the line says.
  assert.match((await lineAfter(2000)) ?? "", /^(Scan the code with your phone to pair it|Your phone is paired\. Scan the code to pair another\.)$/);
  assert.equal(await page.locator(".welcome-qr.away").count(), 0, "the code is on show");
  const pairing = (await (await fetch(`${url}/api/phones`)).json()).pairing;
  assert.match(pairing.code, /^[A-Z2-9]{6}$/);
  // The stick's phone still pairs, if it turns up after all.
  assert.equal((await (await fetch(`${url}/api/setup`)).json()).stickPhone, true);
  await page.close();
});
