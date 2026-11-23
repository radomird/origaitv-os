// The theme in a paired phone's state (T29.1's unit half): the name, the
// mode and every colour GET /api/theme.css names, with the same values, for
// every theme Omarchy ships. The count goes up once when the theme changes
// and not when the same one is handed over again. A phone that isn't paired
// gets none of it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanTheme, themeColors } from "../../../daemon/home.ts";
import { legible, modeOf } from "../../../daemon/legible.ts";
import { Daemon } from "../../../daemon/server.ts";
import { parseColors } from "../../../daemon/themes.ts";
import { pairPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const THEMES = readdirSync(join(ROOT, "themes")).sort();
const TEMPLATE = readFileSync(join(ROOT, "config/omarchy/themed/launcher.css.tpl"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "origaitv-phone-theme-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
const fresh = (name: string): string => {
  const dir = join(scratch, `${name}-${count++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// The TV's colours for a theme, as Omarchy renders OrigaiTV's template into
// it: its own omarchy-theme-color resolves them.
function rendered(theme: string): string {
  const out = execFileSync(join(ROOT, "bin/omarchy-theme-color"), ["--file", join(ROOT, "themes", theme, "colors.toml"), "--all"], { env: { ...process.env, OMARCHY_PATH: ROOT }, encoding: "utf8" });
  const colors: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [key, value] = line.split("\t");
    if (/^[a-z_]+$/.test(key ?? "") && /^#[0-9a-fA-F]{3,8}$/.test(value ?? "")) colors[key] = value;
  }
  return TEMPLATE.replace(/\{\{ *([a-z_]+) *\}\}/g, (_, key) => colors[key] ?? "#000000");
}

// What a stylesheet's lines say, read here a second way: line by line, the
// name before the colon and the value after it.
function declared(css: string): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const line of css.split("\n")) {
    const at = line.indexOf(":");
    if (!line.startsWith("  --") || at < 0) continue;
    colors[line.slice(4, at)] = line.slice(at + 1).trim().replace(/;$/, "");
  }
  return colors;
}

async function tv(): Promise<{ daemon: Daemon; url: string; lan: string }> {
  const state = fresh("state");
  const root = fresh("root");
  writeFileSync(join(root, "settings"), "ORIGAITV_VERSION=1.0.0.r7.gabc1234\nORIGAITV_CHANNEL=stable\n");
  const daemon = new Daemon({ root, state, port: 0, log: () => {}, builtins: null, lanPort: 0, lanHost: "127.0.0.1", address: () => "127.0.0.1", phoneWaitMs: 1500, box: { root: fresh("machine"), exec: async () => null, interfaces: () => ({}), disk: scratch } });
  return { daemon, url: `http://127.0.0.1:${await daemon.listen()}`, lan: `http://127.0.0.1:${daemon.lanPort}` };
}

// Waits until the daemon has had its first look at its builds, 2 s after it
// starts. That look is news for the phones, whatever it finds, so a count
// read before it can't be compared with one read after.
async function firstLookOver(phone: { json(method: string, path: string): Promise<Record<string, any>> }): Promise<void> {
  const { version } = await phone.json("GET", "/api/phone/state");
  for (const until = Date.now() + 5000; Date.now() < until; ) {
    if ((await phone.json("GET", `/api/phone/state?since=${version}`)).version !== version) return;
  }
}

// Omarchy's theme-set hook, handing a theme's colours to the TV.
const hand = (url: string, css: string, name?: string) => fetch(`${url}/api/theme${name ? `?name=${name}` : ""}`, { method: "POST", headers: { "Content-Type": "text/css" }, body: css });

test("T29.1 the colours a stylesheet has, by name, and whether they make a light theme or a dark one", () => {
  assert.deepEqual(themeColors(":root {\n  --background: #1a1b26;\n  --dark-background: #16161e;\n  --accent: rgb(122, 162, 247);\n}\n"), { background: "#1a1b26", "dark-background": "#16161e", accent: "rgb(122, 162, 247)" });
  assert.deepEqual(themeColors(""), {});
  assert.deepEqual(themeColors("body { color: red }"), {});
  assert.deepEqual(themeColors(":root { --a: #111111; --a: #222222; }"), { a: "#222222" }, "the last one counts, as in CSS");
  assert.deepEqual(themeColors(":root { --evil: url(https://evil.example/); --ok: #fff; }"), { ok: "#fff" }, "only colours");

  assert.equal(modeOf("#1a1b26", "#a9b1d6"), "dark");
  assert.equal(modeOf("#eff1f5", "#4c4f69"), "light");
  assert.equal(modeOf("#fff", "#000"), "light");
  assert.equal(modeOf("#808080", "#808080"), "dark");
  for (const [back, words] of [[undefined, "#000000"], ["#ffffff", undefined], ["rgb(255, 255, 255)", "#000000"], [undefined, undefined]] as const) assert.equal(modeOf(back, words), "dark", "dark when it can't tell");
});

test("T29.1 a TV that hasn't been handed a theme says so, and a phone that isn't paired is told nothing", async () => {
  const { daemon, url, lan } = await tv();
  try {
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    const first = await phone.call("GET", "/api/phone/state");
    assert.equal(first.sealed, true, "the state is sealed");
    assert.equal(first.data.theme, null);
    assert.equal(await (await fetch(`${lan}/api/theme.css`)).text(), "");

    assert.equal((await hand(url, rendered("gruvbox"), "gruvbox")).status, 200);
    assert.equal((await phone.json("GET", "/api/phone/state")).theme.name, "gruvbox");
    // Not paired: no state, so no theme, however it asks.
    for (const headers of [{}, { Authorization: "Bearer placeholder" }, { "X-OrigaiTV-Phone": "nobody" }] as Record<string, string>[]) {
      const answer = await fetch(`${lan}/api/phone/state`, { headers });
      const text = await answer.text();
      assert.equal(answer.status, 401);
      assert.ok(!text.includes("gruvbox") && !text.includes("colors") && !text.includes("theme"), text);
    }
    // And a phone that was paired and then forgotten.
    const id = (await phone.json("GET", "/api/phone/state")).phone.id;
    assert.equal((await fetch(`${url}/api/phones/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await phone.call("GET", "/api/phone/state")).status, 401);
  } finally {
    await daemon.close();
  }
});

test("T29.1 in every theme Omarchy ships, the state has the name, the mode and every colour theme.css names, with the same values", async () => {
  const { daemon, url, lan } = await tv();
  try {
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    const template = [...TEMPLATE.matchAll(/^ {2}--([a-z-]+):/gm)].map((match) => match[1]);
    assert.equal(template.length, 20);
    const modes = new Set<string>();
    for (const theme of THEMES) {
      const css = rendered(theme);
      assert.equal((await hand(url, css, theme)).status, 200, `the theme ${theme} took`);
      const served = await (await fetch(`${lan}/api/theme.css`)).text();
      assert.equal(served, legible(cleanTheme(css)), `${theme}: theme.css is what it was`);
      const { theme: seen } = await phone.json("GET", "/api/phone/state");
      assert.deepEqual(Object.keys(seen), ["name", "mode", "colors"]);
      assert.equal(seen.name, theme);
      // Every name, in the same order, with the same value.
      assert.deepEqual(Object.entries(seen.colors), Object.entries(declared(served)), theme);
      for (const name of template) assert.match(seen.colors[name], /^#[0-9a-f]{6}$/i, `${theme}: ${name}`);
      for (const name of ["accent-ink", "accent-on", "red-ink", "red-on"]) assert.match(seen.colors[name], /^#[0-9a-f]{6}$/, `${theme}: ${name}, which the TV adds`);
      // The mode is Omarchy's own word for the theme.
      assert.equal(seen.mode, parseColors(readFileSync(join(ROOT, "themes", theme, "colors.toml"), "utf8")).mode, `${theme}: dark or light, as its colors.toml says`);
      modes.add(seen.mode);
    }
    assert.deepEqual([...modes].sort(), ["dark", "light"], "Omarchy ships both kinds");
  } finally {
    await daemon.close();
  }
});

test("T29.1 the count goes up once when the theme changes, a phone that was waiting hears at once, and the same theme again changes nothing", async () => {
  const { daemon, url, lan } = await tv();
  // Every event the TV's pages hear.
  const heard: string[] = [];
  const events = await fetch(`${url}/api/events`);
  const reader = events.body!.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      heard.push(Buffer.from(value!).toString("utf8"));
    }
  })();
  const themeEvents = () => heard.join("").split("event: theme\n").length - 1;
  try {
    const phone = await pairPhone(lan, daemon.phones.code().code, "iphone");
    const other = await pairPhone(lan, daemon.phones.code().code, "ipad");
    assert.equal((await hand(url, rendered("tokyo-night"), "tokyo-night")).status, 200);
    await firstLookOver(phone);
    const first = await phone.json("GET", "/api/phone/state");
    assert.deepEqual([first.theme.name, first.theme.mode, first.theme.colors.background], ["tokyo-night", "dark", "#1a1b26"]);

    // Another theme: a phone that was waiting hears at once, a count on.
    const waiting = phone.json("GET", `/api/phone/state?since=${first.version}`);
    const asked = Date.now();
    assert.equal((await hand(url, rendered("catppuccin-latte"), "catppuccin-latte")).status, 200);
    const second = await waiting;
    assert.ok(Date.now() - asked < 1000, "before the wait ran out");
    assert.equal(second.version, first.version + 1, "once");
    assert.deepEqual([second.theme.name, second.theme.mode, second.theme.colors.background], ["catppuccin-latte", "light", "#eff1f5"]);
    assert.deepEqual((await other.json("GET", "/api/phone/state")).theme, second.theme, "and so does every other phone");
    assert.notDeepEqual(second.theme.colors, first.theme.colors);

    // The same theme handed over again, as when the TV session starts: the
    // count stays, and a phone that waits isn't woken.
    const told = themeEvents();
    assert.equal((await hand(url, rendered("catppuccin-latte"), "catppuccin-latte")).status, 200);
    const third = await phone.json("GET", `/api/phone/state?since=${second.version}`);
    assert.equal(third.version, second.version, "the wait ran out with nothing new");
    assert.deepEqual(third.theme, second.theme);
    // The TV's own pages still hear of it, as they did.
    for (let i = 0; i < 50 && themeEvents() === told; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(themeEvents(), told + 1);

    // The same colours under another name are another theme.
    assert.equal((await hand(url, rendered("catppuccin-latte"), "my-latte")).status, 200);
    const fourth = await phone.json("GET", "/api/phone/state");
    assert.deepEqual([fourth.version, fourth.theme.name], [second.version + 1, "my-latte"]);
    assert.deepEqual(fourth.theme.colors, second.theme.colors);
    // From a hook that doesn't say the name, there's none.
    assert.equal((await hand(url, rendered("catppuccin-latte"))).status, 200);
    const fifth = await phone.json("GET", "/api/phone/state");
    assert.deepEqual([fifth.version, fifth.theme.name, fifth.theme.mode], [second.version + 2, null, "light"]);
    assert.equal((await hand(url, rendered("catppuccin-latte"))).status, 200);
    assert.equal((await phone.json("GET", "/api/phone/state")).version, fifth.version, "and that one again changes nothing either");

    // Something that isn't a theme is refused and changes nothing.
    assert.equal((await hand(url, "body { color: red }", "nothing")).status, 400);
    const sixth = await phone.json("GET", "/api/phone/state");
    assert.deepEqual([sixth.version, sixth.theme], [fifth.version, fifth.theme]);

    // Something else changing, such as one more phone, raises the count
    // and leaves the theme as it is.
    await pairPhone(lan, daemon.phones.code().code, "a third");
    const seventh = await phone.json("GET", "/api/phone/state");
    assert.notEqual(seventh.version, fifth.version);
    assert.deepEqual(seventh.theme, fifth.theme);
  } finally {
    await reader.cancel().catch(() => {});
    await daemon.close();
  }
});
