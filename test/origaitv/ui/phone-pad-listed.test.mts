// A phone in game mode isn't a controller on a cable (T29.3), on the real
// Settings pages in Chromium. The box has a real wired controller, and a
// paired phone opens game mode the whole way: the daemon, and the input
// helper's own code holding its connection (unit/phonepad-helper.py). Only
// the kernel is stood in for: when the helper makes the phone's controller,
// the test puts it where the kernel would, with the devices that aren't
// hardware. Settings then lists the real controller and not the phone's,
// and the phone's row under Phones is as it was.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { AskWatch } from "../../../daemon/asks.ts";
import { PHONE_PAD, readPads } from "../../../daemon/box.ts";
import { Controllers, type ControllerAnswer, type ControllerAsk } from "../../../daemon/controllers.ts";
import type { Daemon } from "../../../daemon/server.ts";
import { StandInBluez } from "../fixtures/controllers/bluez.mts";
import { pairFromTv } from "../unit/phone-client.mts";
import { rest, ROOT, startBox } from "./box.mts";

const require = createRequire(`${process.env.ORIGAITV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const WIRED = "8BitDo Pro 2 Wired Controller";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let browser: Browser;
let daemon: Daemon;
let url = "";
let driver: Controllers;
let watch: AskWatch<ControllerAsk, ControllerAnswer>;
let helper: ChildProcess;
let screen: Server;
const errors: string[] = [];
// What the input helper said, a line for each controller it made or dropped.
const said: Record<string, any>[] = [];
const scratch = mkdtempSync(join(tmpdir(), "origaitv-phone-pad-"));
// A short folder: a socket's path has to fit in about a hundred bytes.
const run = mkdtempSync(join(tmpdir(), "otv-pad-"));
const tree = join(scratch, "machine");

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, path), text);
};

// An input device where the kernel keeps it, with the link to it that
// /sys/class/input has: a real one under the port it's plugged into, and
// one a program made under devices/virtual.
function device(event: string, dev: string, name: string, bus: string, under: string): void {
  const number = event.replace("event", "input");
  const at = `sys/devices/${under}/${number}/${event}`;
  put(`${at}/dev`, `${dev}\n`);
  put(`${at}/device/name`, `${name}\n`);
  put(`${at}/device/id/bustype`, `${bus}\n`);
  put(`run/udev/data/c${dev}`, "E:ID_INPUT=1\nE:ID_INPUT_JOYSTICK=1\n");
  mkdirSync(join(tree, "sys/class/input"), { recursive: true });
  symlinkSync(join("../../devices", under, number, event), join(tree, "sys/class/input", event));
}

async function until(done: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !(await done()); await sleep(10)) assert.ok(Date.now() < end, `${what} didn't happen in ${ms} ms`);
}

before(async () => {
  mkdirSync(join(tree, "sys/class/bluetooth/hci0"), { recursive: true });
  // A keyboard, and a real controller on a cable.
  device("event3", "13:67", "AT Translated Set 2 keyboard", "0011", "platform/i8042/serio0/input");
  writeFileSync(join(tree, "run/udev/data/c13:67"), "E:ID_INPUT=1\nE:ID_INPUT_KEYBOARD=1\n");
  device("event7", "13:71", WIRED, "0003", "pci0000:00/0000:00:14.0/usb1/1-2/1-2:1.0/input");
  ({ daemon, url } = await startBox(0, undefined, { features: { phonepad: true }, box: { root: tree, exec: async () => null, interfaces: () => ({}), disk: scratch } }));
  await fetch(`${url}/api/backgrounds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "field" }) });

  // The TV session's part of Settings, controllers, with no Bluetooth
  // controller around.
  const bluez = new StandInBluez([]);
  driver = new Controllers({ run: bluez.run, look: bluez.look, inputs: bluez.inputs, log: () => {}, settleMs: 60 });
  watch = new AskWatch<ControllerAsk, ControllerAnswer>({
    url: `${url}/`,
    path: "api/controllers/ask",
    what: "controllers",
    handle: (ask) => driver.handle(ask),
    failed: (error) => ({ ok: false, bluetooth: "none", looking: false, controllers: [], why: "failed", error: error.message }),
    log: () => {},
    retryMs: 50,
  });
  watch.start();

  // The input helper's own code, and the screen daemon's socket it tells
  // about the guide button.
  mkdirSync(join(run, "origaitv"));
  screen = createServer((connection) => connection.on("data", () => connection.end('{"ok":true}\n')));
  await new Promise<void>((resolve) => screen.listen(join(run, "origaitv", "screen.sock"), resolve));
  helper = spawn("python3", ["-I", join(ROOT, "test/origaitv/unit/phonepad-helper.py"), join(ROOT, "daemon"), String(new URL(url).port)], { env: { ...process.env, XDG_RUNTIME_DIR: run }, stdio: ["ignore", "pipe", "inherit"] });
  let held = "";
  helper.stdout!.setEncoding("utf8");
  helper.stdout!.on("data", (chunk: string) => {
    held += chunk;
    let end;
    while ((end = held.indexOf("\n")) >= 0) {
      const line = held.slice(0, end);
      held = held.slice(end + 1);
      if (line.startsWith("{")) said.push(JSON.parse(line));
    }
  });
  await until(() => daemon.pads.ready(), "the input helper connecting to the daemon");
  browser = await chromium.launch({ executablePath: process.env.ORIGAITV_UI_BROWSER });
});

after(async () => {
  watch?.stop();
  driver?.stop();
  helper?.kill("SIGKILL");
  screen?.close();
  await browser?.close();
  await daemon?.close();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(run, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

async function tv(): Promise<Page> {
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
  await page.waitForSelector("html[data-look] #page .focused");
  await rest(page);
  return page;
}

const go = (page: Page, route: string) => page.evaluate((r) => (window as unknown as { origaitvLauncher: { go(route: string): void } }).origaitvLauncher.go(r), route);

// What Settings, Phones and controllers shows on a page opened now: each
// phone's row and each controller's, as written, and then the same on the
// page that pairs a controller.
async function shown(): Promise<{ phones: string[]; controllers: string[]; pairing: string[] }> {
  const page = await tv();
  try {
    await go(page, "settings/phones");
    // The list of controllers comes a moment after the panel: wait for the
    // wired one, which is there throughout.
    await page.waitForSelector('.panel [data-controller="usb"]').catch(() => {
      throw new Error("Phones and controllers never listed the controller on a cable");
    });
    // Each row's words as the page wrote them, its name and then its value.
    // Not as they're laid out, which they aren't yet while the panel slides
    // in, and which a look may show in lower case.
    const rows = (selector: string) => page.locator(selector).evaluateAll((els) => els.map((el) => [...el.children].map((part) => (part.textContent ?? "").trim()).join(" | ")));
    const phones = await rows('.panel [data-action^="phone-"]');
    const controllers = await rows(".panel [data-controller]");
    await go(page, "settings/controllers");
    await page.waitForSelector('.settings-panel[data-page="controllers"] [data-controller="usb"]').catch(() => {
      throw new Error("the page that pairs a controller never listed the one on a cable");
    });
    return { phones, controllers, pairing: await rows('.settings-panel[data-page="controllers"] [data-controller]') };
  } finally {
    await page.close();
  }
}

test("T29.3 with a phone in game mode and a real controller both connected, Settings lists the real one and not the phone's, and the phone's row is as it was", async () => {
  const lan = `http://127.0.0.1:${daemon.lanPort}`;
  const phone = await pairFromTv(url, lan, "Ana's phone");
  const state = () => phone.json("GET", "/api/phone/state");

  // Before game mode: the phone under Phones, and the controller on a cable.
  const before = await shown();
  assert.equal(before.phones.length, 1);
  assert.match(before.phones[0], /^Ana's phone \| Since \d+ \w+ · Remove$/);
  assert.deepEqual(before.controllers, [`${WIRED} | Plugged in`]);
  assert.deepEqual(before.pairing, before.controllers);
  assert.deepEqual((await state()).controllers, { phones: 0, most: 4 });

  // The phone opens game mode. The helper makes its controller, and the
  // kernel has it from then, as a device that isn't hardware.
  const pad = await phone.pad();
  assert.equal(pad.slot, 1);
  await until(() => said.some((line) => line.made === 1), "the input helper making the phone's controller");
  const made = said.find((line) => line.made === 1)!;
  assert.equal(made.name, PHONE_PAD);
  device("event20", "13:84", made.name, made.id[0].toString(16).padStart(4, "0"), "virtual/input");
  assert.deepEqual((await state()).controllers, { phones: 1, most: 4 }, "the phone is a controller now");
  // The box has both, and both say they're on USB.
  assert.deepEqual(await readPads(tree), [{ name: PHONE_PAD, bus: "usb", phone: true }, { name: WIRED, bus: "usb" }]);

  // Settings, on a page opened now: the real one only, and the phone's row
  // as it was.
  const during = await shown();
  assert.deepEqual(during.controllers, before.controllers, "the real controller, and not the phone's");
  assert.deepEqual(during.pairing, before.pairing, "nor on the page that pairs one");
  assert.deepEqual(during.phones, before.phones, "the phone's row under Phones is as it was");
  assert.ok(![...during.controllers, ...during.pairing].some((row) => /phone controller/i.test(row)));

  pad.close();
  await until(() => said.some((line) => line.gone === 1), "the input helper dropping the phone's controller");
});
