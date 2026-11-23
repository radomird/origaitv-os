// The phone that installed the TV from the USB stick (daemon/phones.ts,
// install/tv/state.sh): the stick gave it a secret and handed the same one
// to the TV, which first boot puts in the daemon's state. Until setup is
// done, that secret pairs that phone once, with no code on the TV, and the
// welcome screen hears that it's still to come. Once setup is done, it goes.

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { x25519Pair } from "../../../daemon/phone-channel.ts";
import { Phones } from "../../../daemon/phones.ts";
import { Daemon } from "../../../daemon/server.ts";
import { pairPhone } from "./phone-client.mts";

const ROOT = join(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "origaitv-stick-pairing-"));
let n = 0;

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
function asking(k: string | Buffer, name = "x", key: Uint8Array = x25519Pair().public) {
  return { key: b64u(key), name, proof: b64u(createHmac("sha256", k).update("origaitv pair v1").update(key).digest()) };
}

// A daemon's state with the stick's secret in it, as first boot leaves it.
function handed(secret: Buffer): string {
  const path = join(dir, `stick-pairing-${++n}.json`);
  writeFileSync(path, `${JSON.stringify({ secret: b64u(secret) })}\n`, { mode: 0o600 });
  return path;
}

test("T30.2 the stick's secret pairs one phone with no code on show, and then it's gone", () => {
  const secret = randomBytes(16);
  const path = handed(secret);
  const phones = new Phones({ path: join(dir, `phones-${n}.json`), handed: path });
  assert.equal(phones.waitingForStick(), true);
  assert.equal(phones.showing(), null, "no code on the TV");
  assert.deepEqual(phones.pair(asking(randomBytes(16)), undefined, true), { error: "That isn't the code on your TV" });
  assert.equal(phones.waitingForStick(), true, "a wrong try leaves it for the right phone");
  const paired = phones.pair(asking(secret, "Ana's iPhone"), undefined, true);
  assert.ok("id" in paired);
  assert.equal(paired.phone.name, "Ana's iPhone");
  assert.ok(phones.key(paired.id), "the phone's key is kept, as any phone's is");
  assert.equal(phones.waitingForStick(), false);
  assert.ok(!existsSync(path), "it pairs one phone");
  assert.deepEqual(phones.pair(asking(secret, "again"), undefined, true), { error: "That code ran out. Pair again from your TV." });
});

test("T30.2 the stick's secret leaves the code on show alone, and the code leaves the stick's secret", () => {
  const secret = randomBytes(16);
  const path = handed(secret);
  const phones = new Phones({ path: join(dir, `phones-${n}.json`), handed: path });
  const { code } = phones.code();
  // Wrong tries count against the code, as they always have.
  for (let i = 0; i < 4; i++) phones.pair(asking("ZZZZZZ"), undefined, true);
  assert.ok("id" in phones.pair(asking(secret, "stick"), undefined, true));
  assert.deepEqual(phones.showing()?.code, code, "the code is still there for another phone");
  assert.ok("id" in phones.pair(asking(code, "another"), undefined, true));

  const again = randomBytes(16);
  const second = new Phones({ path: join(dir, `phones-${++n}.json`), handed: handed(again) });
  const shown = second.code().code;
  assert.ok("id" in second.pair(asking(shown, "by code"), undefined, true));
  assert.equal(second.waitingForStick(), true, "the stick's phone can still pair after another did by code");
});

test("T30.2 once setup is done, the stick's secret pairs nothing, and it goes", () => {
  const secret = randomBytes(16);
  const path = handed(secret);
  const phones = new Phones({ path: join(dir, `phones-${n}.json`), handed: path });
  assert.deepEqual(phones.pair(asking(secret), undefined, false), { error: "That code ran out. Pair again from your TV." });
  assert.ok(!existsSync(path));
  assert.equal(phones.waitingForStick(), false);
});

test("the stick's page's phone: setup shows its code meanwhile, and the secret still pairs that phone, from its own browser", () => {
  const secret = randomBytes(16);
  const path = join(dir, `stick-pairing-${++n}.json`);
  writeFileSync(path, JSON.stringify({ secret: b64u(secret), wait: false }), { mode: 0o600 });
  const phones = new Phones({ path: join(dir, `phones-${n}.json`), handed: path });
  assert.equal(phones.waitingForStick(), false, "no wait: the code shows at once");
  const { code } = phones.code();
  assert.ok("id" in phones.pair(asking(secret, "Safari"), undefined, true), "the link's secret pairs");
  assert.ok(!existsSync(path));
  assert.equal(phones.showing()?.code, code, "the code is still there");
});

test("a stick secret that isn't 16 bytes, or no file, is no secret", () => {
  const path = join(dir, `stick-pairing-${++n}.json`);
  writeFileSync(path, JSON.stringify({ secret: b64u(randomBytes(8)) }));
  assert.equal(new Phones({ path: join(dir, `phones-${n}.json`), handed: path }).waitingForStick(), false);
  writeFileSync(path, "not json");
  assert.equal(new Phones({ path: join(dir, `phones-${n}.json`), handed: path }).waitingForStick(), false);
  assert.equal(new Phones({ path: join(dir, `phones-${n}.json`) }).waitingForStick(), false);
});

// --- Through the daemon -------------------------------------------------------

let daemon: Daemon;
let tv = "";
let phone = "";
const secret = randomBytes(16);

before(async () => {
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "stick-pairing.json"), JSON.stringify({ secret: b64u(secret) }), { mode: 0o600 });
  daemon = new Daemon({
    root: ROOT,
    state,
    builtins: null,
    port: 0,
    log: () => {},
    running: "0.3.0-1",
    lanPort: 0,
    lanHost: "127.0.0.1",
    address: () => "192.168.1.20",
    phoneWaitMs: 400,
  });
  tv = `http://127.0.0.1:${await daemon.listen()}`;
  phone = `http://127.0.0.1:${daemon.lanPort}`;
});

after(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

const setupInfo = async () => (await (await fetch(`${tv}/api/setup`)).json()) as { stickPhone?: boolean; phones: string[] };

test("T30.2 during setup the welcome screen hears the stick's phone is to come, and that phone pairs on the phones' port with no code shown", async () => {
  assert.equal((await setupInfo()).stickPhone, true);
  assert.equal((await (await fetch(`${tv}/api/phones`)).json()).pairing, null, "no code on show");
  const paired = await pairPhone(phone, { secret: b64u(secret) }, "Ana's iPhone");
  assert.equal((await paired.fetch("/api/phone/state")).status, 200, "it's a paired phone like any other");
  const info = await setupInfo();
  assert.equal(info.stickPhone, false);
  assert.deepEqual(info.phones, ["Ana's iPhone"]);
  await assert.rejects(pairPhone(phone, { secret: b64u(secret) }, "again"), /ran out/);
});

test("T30.2 origaitv-phone-call pairs with a secret from the environment, as the image check's phone does", async () => {
  const again = randomBytes(16);
  writeFileSync(join(dir, "state", "stick-pairing.json"), JSON.stringify({ secret: b64u(again) }), { mode: 0o600 });
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) =>
      execFile(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "daemon/phone-call.ts"), "pair-secret", "the check's phone"],
        { env: { ...process.env, ORIGAITV_PHONE_URL: phone, ...env } },
        (error, out, err) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out, err }),
      ),
    );
  const none = await run({ ORIGAITV_PAIR_SECRET: "" });
  assert.equal(none.code, 2);
  assert.match(none.err, /ORIGAITV_PAIR_SECRET/);
  const done = await run({ ORIGAITV_PAIR_SECRET: b64u(again) });
  assert.equal(done.code, 0, done.err);
  const kept = JSON.parse(readFileSync(done.out.trim(), "utf8"));
  assert.match(kept.id, /^p-[0-9a-f]{8}$/);
  assert.ok((await setupInfo()).phones.includes("the check's phone"));
});

test("T30.2 with setup done the welcome screen hears nothing of the stick's phone", async () => {
  writeFileSync(join(dir, "state", "stick-pairing.json"), JSON.stringify({ secret: b64u(secret) }), { mode: 0o600 });
  assert.equal((await fetch(`${tv}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true }) })).status, 200);
  // Setup's end takes it away by itself, with no pairing call after it, so
  // a setup started again doesn't wait for a phone that never came.
  assert.ok(!existsSync(join(dir, "state", "stick-pairing.json")), "it goes as setup ends");
  assert.equal((await fetch(`${tv}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: false }) })).status, 200);
  assert.equal((await setupInfo()).stickPhone, false, "a setup started again has no stick phone to wait for");
  assert.equal((await fetch(`${tv}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true }) })).status, 200);
  writeFileSync(join(dir, "state", "stick-pairing.json"), JSON.stringify({ secret: b64u(secret) }), { mode: 0o600 });
  assert.equal((await setupInfo()).stickPhone, false);
  await assert.rejects(pairPhone(phone, { secret: b64u(secret) }, "late"), /ran out/);
  assert.ok(!existsSync(join(dir, "state", "stick-pairing.json")), "it goes");
});
