// Setup's AI step moves on by itself once the plan is signed in (T30.6),
// with setup's own switch on, in a real Chromium. On the NUC the TV stayed
// on "Sign in to Claude" after the sign-in, and Back then jumped a step. So
// here: the sign-in finishing moves the TV to Who's watching with no press,
// Back from there goes back one step to the AI step and stays, and a phone
// on its own (as the iPhone app will be) gets the terms and then the
// sign-in, and moves setup on with no TV page asking. Root's hand-over and
// the CLI are the image layer's: the test plays their part through the
// build drop, as ai-step.test.mts does.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { startBox } from "./box.mts";
import { pairPhone, type TestPhone } from "../unit/phone-client.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";
let lan = "";
let state = "";
let run = "";
const errors: string[] = [];
const tools = mkdtempSync(join(tmpdir(), "origaitv-ai-moves-on-"));
const path = process.env.PATH;

before(async () => {
  writeFileSync(join(tools, "qrencode"), `#!/bin/bash\necho '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><rect width="21" height="21"/></svg>'\n`);
  chmodSync(join(tools, "qrencode"), 0o755);
  process.env.PATH = `${tools}:${path}`;
  let builds = "";
  ({ daemon, url, state, builds } = await startBox(0, undefined, { features: { setup2: true } }));
  run = join(builds, "..", "build-run");
  lan = `http://127.0.0.1:${daemon.lanPort}`;
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
  process.env.PATH = path;
  rmSync(tools, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

function atAi(ai?: object): void {
  writeFileSync(join(state, "features.json"), JSON.stringify({ setup2: true }));
  writeFileSync(join(state, "setup.json"), JSON.stringify({ done: false, step: "ai", finished: { welcome: "2026-11-05T10:00:00Z", ready: "2026-11-05T10:01:00Z", country: "2026-11-05T10:02:00Z" } }));
  rmSync(join(state, "ai.json"), { force: true });
  rmSync(join(state, "terms.json"), { force: true });
  if (ai) writeFileSync(join(state, "ai.json"), JSON.stringify(ai));
  rmSync(join(state, "plan-sign-in.json"), { force: true });
  rmSync(join(state, "build-drop"), { recursive: true, force: true });
  rmSync(run, { recursive: true, force: true });
}

async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      setTimeout(() => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true })), 0);
    };
  });
  await page.goto(`${url}/`);
  return page;
}

async function paired(): Promise<TestPhone> {
  const code = (await (await fetch(`${url}/api/phones/pair`, { method: "POST" })).json()).pairing.code;
  return pairPhone(lan, code, "iphone");
}

// Root's hand-over and the CLI's sign-in, as they'd write their status.
function signInSays(status: Record<string, unknown>): void {
  mkdirSync(join(run, "sign-in"), { recursive: true });
  writeFileSync(join(run, "sign-in", "status.json"), JSON.stringify({ provider: "claude", at: new Date(Date.now() + 1000).toISOString(), ...status }));
}

const bar = (page: Page) => page.locator(".bar .bar-step").textContent();
const phoneState = async (phone: TestPhone) => (await phone.fetch("/api/phone/state")).json();

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(what);
}

test("T30.6 with Claude signed in, setup moves to Who's watching with no press, and Back from there goes back one step and stays", async () => {
  atAi();
  const page = await tv();
  try {
    await page.waitForSelector(".ai-cards");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ai-options");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".terms-list");
    const phone = await paired();
    // The terms, on the phone, as the iPhone app reads them.
    const terms = (await phoneState(phone)).ai;
    assert.deepEqual([terms.ask, terms.provider, terms.path], ["terms", "claude", "plan"]);
    assert.equal((await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "plan" }) })).status, 200);
    await page.waitForSelector(".ai-options");
    await until(async () => existsSync(join(state, "build-drop", "sign-in.json")), "the sign-in started");
    signInSays({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true&state=s7Q", pastes: true });
    await page.waitForSelector(".ai-qr:not(.hidden) .qr[src]");
    // Signed in on the phone: the TV moves on with no press.
    signInSays({ state: "done" });
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "7 of 12 · who's watching");
    assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "people");

    // Back goes to the AI step, which says it's signed in and waits there
    // for Continue, rather than going straight on again.
    await page.waitForSelector('[data-action="done"].focused');
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "6 of 12 · AI");
    await page.waitForFunction(() => document.querySelector('[data-line="sign-in"]')?.textContent === "You're signed in to Claude Pro or Max");
    await page.waitForSelector('[data-action="continue"].focused');
    assert.deepEqual(await page.locator(".ai-options > .button:not(.hidden)").allTextContents(), ["Continue"]);
    await page.waitForTimeout(2500);
    assert.equal(await bar(page), "6 of 12 · AI", "Back stays one step back");
    assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "ai");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "7 of 12 · who's watching");
  } finally {
    await page.close();
  }
});

test("T30.6 a phone on its own gets the terms, then the sign-in, and setup moves on once it's done, with no TV page asking", async () => {
  atAi({ provider: "claude", path: "plan" });
  const phone = await paired();
  const terms = (await phoneState(phone)).ai;
  assert.equal(terms.ask, "terms");
  assert.equal((await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "plan" }) })).status, 200);
  // Accepting the terms starts the sign-in, with nothing on the TV asking.
  assert.deepEqual(JSON.parse(readFileSync(join(state, "build-drop", "sign-in.json"), "utf8")), { build: null, provider: "claude" });
  const link = "https://claude.ai/oauth/authorize?code=true&state=s7Q";
  signInSays({ state: "waiting", url: link, pastes: true });
  const ask = (await phoneState(phone)).ai;
  assert.deepEqual([ask.ask, ask.signIn], ["sign-in", { url: link, pastes: true }]);
  assert.equal((await phone.fetch("/api/phone/ai/sign-in/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "good-code#s7Q" }) })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "build-drop", "sign-in-code.json"), "utf8")), { code: "good-code#s7Q" });
  // Signed in: the phone's next state has nothing more to ask, and setup
  // is on Who's watching. The state that found it done was read a count
  // behind, so the phone asks again at once.
  signInSays({ state: "done" });
  assert.equal((await phoneState(phone)).ai, null, "nothing more to ask once it's signed in");
  const next = await phoneState(phone);
  assert.deepEqual([next.ai, next.setup.step], [null, "people"]);
  assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "people");
});

test("T30.6 a sign-in finished in Settings, or after setup's AI step, doesn't move setup", async () => {
  atAi({ provider: "claude", path: "plan" });
  const phone = await paired();
  await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "plan" }) });
  // Setup went on to Who's watching with the sign-in still waiting.
  await fetch(`${url}/api/setup/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "ai" }) });
  await fetch(`${url}/api/setup/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "people" }) });
  signInSays({ state: "done" });
  await phoneState(phone);
  assert.equal((await (await fetch(`${url}/api/ai/sign-in`)).json()).signIn.signedIn, true);
  assert.equal((await (await fetch(`${url}/api/setup`)).json()).setup.step, "goal");
});

test("T30.6 a key saved on the phone moves setup on to Who's watching by itself, and Back stops at the AI step", async () => {
  atAi({ provider: "claude", path: "key" });
  const page = await tv();
  try {
    await page.waitForSelector(".terms-list");
    const phone = await paired();
    assert.equal((await phoneState(phone)).ai.ask, "terms");
    assert.equal((await phone.fetch("/api/phone/terms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "claude", path: "key" }) })).status, 200);
    await until(async () => (await phoneState(phone)).ai?.ask === "key", "the phone asks for the key");
    assert.equal((await phone.fetch("/api/phone/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: `sk-ant-${"k".repeat(40)}` }) })).status, 200);
    // On with no press on the TV.
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "7 of 12 · who's watching");
    assert.equal((await phoneState(phone)).ai, null, "nothing more to ask");
    // Back shows the AI step as done, with Continue, and stays.
    await page.waitForSelector('[data-action="done"].focused');
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".bar .bar-step")?.textContent === "6 of 12 · AI");
    await page.waitForSelector('[data-action="continue"].focused');
    await page.waitForTimeout(2000);
    assert.equal(await bar(page), "6 of 12 · AI");
  } finally {
    await page.close();
  }
});
