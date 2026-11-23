// The theme in a paired phone's state (T29.1's screen half): a theme picked
// in Settings, on the real page, with Omarchy's part stood in for. The
// phone's state then has the theme's name, its mode, and each colour with
// the value the TV's own page draws with. Its count went up once.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { Daemon } from "../../../daemon/server.ts";
import { pairPhone } from "../unit/phone-client.mts";
import { rest, ROOT, startBox } from "./box.mts";
import { rendered } from "./legible.mts";

const require = createRequire(join(process.env.ORIGAITV_UI_MODULES ?? join(ROOT, "node_modules"), "x.js"));
const { chromium } = require("playwright-core") as typeof import("playwright-core");

let browser: Browser;
let daemon: Daemon;
let url = "";

before(async () => {
  ({ daemon, url } = await startBox());
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  await browser?.close();
  await daemon?.close();
});

// Omarchy's theme-set hook, handing a theme's colours to the TV.
const hand = async (theme: string) => assert.equal((await fetch(`${url}/api/theme?name=${theme}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: rendered(theme) })).status, 200, `the theme ${theme} took`);

// A TV at 1080p. The screen daemon is stood in for: asked to set a theme, it
// does what Omarchy does on the box, and hands the TV that theme's colours.
async function tv(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.exposeFunction("omarchySetsTheme", hand);
  await page.addInitScript(() => {
    const w = window as unknown as { origaitvScreen: (json: string) => void; origaitvScreenReply?: (id: number, reply: string) => void; omarchySetsTheme: (theme: string) => Promise<void> };
    w.origaitvScreen = (json: string) => {
      const request = JSON.parse(json);
      const done = () => w.origaitvScreenReply?.(request.id, JSON.stringify({ ok: true }));
      if (request.cmd === "theme-set") void w.omarchySetsTheme(request.theme).then(done);
      else setTimeout(done, 0);
    };
  });
  await page.goto(`${url}/`);
  await page.waitForSelector(".grid .tile.focused");
  await rest(page);
  return page;
}

// The colours the page draws with, by the names the phone was given.
const drawn = (page: Page, names: string[]) => page.evaluate((list) => Object.fromEntries(list.map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()])), names);

// The page once it has taken the theme whose background this is.
const drawnIn = (page: Page, background: string) =>
  page.waitForFunction((colour) => getComputedStyle(document.documentElement).getPropertyValue("--background").trim() === colour, background).catch(() => {
    throw new Error(`the tv's page never drew with the background ${background}`);
  });

// The phone's state once its count has stood still for three seconds. The
// daemon looks at its builds every 2 s, and its first look is news for the
// phones too, so a shorter wait could end just before it.
async function quiet(phone: { json(method: string, path: string): Promise<Record<string, any>> }): Promise<Record<string, any>> {
  let state = await phone.json("GET", "/api/phone/state");
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const next = await phone.json("GET", "/api/phone/state");
    if (next.version === state.version) return next;
    state = next;
  }
  throw new Error("the phone's state never stood still");
}

test("T29.1 a theme picked in Settings is in a paired phone's state, with the colours the TV draws with, and the count goes up once", async () => {
  await hand("tokyo-night");
  const phone = await pairPhone(`http://127.0.0.1:${daemon.lanPort}`, daemon.phones.code().code, "iphone");
  const page = await tv();
  try {
    const first = await phone.json("GET", "/api/phone/state");
    assert.deepEqual([first.theme.name, first.theme.mode], ["tokyo-night", "dark"]);
    await drawnIn(page, first.theme.colors.background);
    assert.deepEqual(await drawn(page, Object.keys(first.theme.colors)), first.theme.colors, "the phone has the colours the TV draws with");

    // Settings, Themes and backgrounds, Theme, and the list of them. Opening
    // Settings is news for the phone too, so the count is read once the
    // list is up and the phone has heard of all of it.
    await page.evaluate(() => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go("settings/look"));
    await page.locator('.panel [data-action="theme"]').click();
    await page.waitForSelector('[data-action="theme-catppuccin-latte"]');
    const before = await quiet(phone);
    assert.deepEqual(before.theme, first.theme, "nothing so far changed the theme");

    // A light one. A phone that was waiting hears at once.
    const waiting = phone.json("GET", `/api/phone/state?since=${before.version}`);
    await page.locator('[data-action="theme-catppuccin-latte"]').click();
    const second = await waiting;
    assert.deepEqual([second.theme.name, second.theme.mode], ["catppuccin-latte", "light"]);
    assert.notDeepEqual(second.theme.colors, first.theme.colors);
    await drawnIn(page, second.theme.colors.background);
    assert.deepEqual(await drawn(page, Object.keys(second.theme.colors)), second.theme.colors, "and the new theme's, as the TV draws them now");
    // Once everything the pick set off has settled, the count is one on.
    const settled = await quiet(phone);
    assert.equal(settled.version, before.version + 1, "once");
    assert.deepEqual(settled.theme, second.theme);

    // What anybody can read as CSS says the same.
    const css = await (await fetch(`http://127.0.0.1:${daemon.lanPort}/api/theme.css`)).text();
    for (const [name, value] of Object.entries(second.theme.colors)) assert.ok(css.includes(`  --${name}: ${value};\n`), `theme.css has ${name} as ${value}`);
    assert.equal(css.split("\n").filter((line) => line.startsWith("  --")).length, Object.keys(second.theme.colors).length, "and no colour the state lacks");
  } finally {
    await page.close();
  }
});
