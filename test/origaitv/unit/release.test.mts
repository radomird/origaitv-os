// Which release a TV runs, for Settings, System (T30.3's unit half): the
// package's version on stable, or else the release its ISO wrote, and on
// edge the build's own version beside it, never in its place.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { installedRelease, isRelease, releaseOf } from "../../../daemon/release.ts";
import { Daemon } from "../../../daemon/server.ts";

const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "origaitv-release-"));
const daemons: Daemon[] = [];

after(async () => {
  for (const daemon of daemons) await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("T30.3 a release's version is plain, a candidate's has its rc, and a build's isn't one", () => {
  for (const version of ["1.0.0", "1.0.0-rc4", "0.1.4", "10.2.13-rc12"]) assert.equal(isRelease(version), true, version);
  for (const version of ["0.2.0.r1061.g91b63a2e0", "dev", "", "1.0", "1.0.0-rc0", "01.0.0", "1.0.0rc4", "1.0.0-beta1", "1.0.0\n"]) {
    assert.equal(isRelease(version), false, JSON.stringify(version));
  }
});

test("T30.3 an edge build from the 1.0.0-rc4 ISO runs 1.0.0-rc4", () => {
  assert.equal(releaseOf("0.2.0.r1061.g91b63a2e0", "1.0.0-rc4"), "1.0.0-rc4");
});

test("T30.3 on stable the package's release wins over the ISO's, once it's updated", () => {
  assert.equal(releaseOf("1.0.0", "1.0.0-rc4"), "1.0.0");
  assert.equal(releaseOf("1.0.1", ""), "1.0.1");
});

test("T30.3 a box from an edge ISO, or a checkout, has no release", () => {
  assert.equal(releaseOf("0.2.0.r1061.g91b63a2e0", ""), null);
  assert.equal(releaseOf("dev", ""), null);
  assert.equal(releaseOf("dev", "not a version"), null);
});

test("the ISO's file is read by its first line, and a missing one is empty", async () => {
  const file = join(scratch, "release");
  writeFileSync(file, " 1.0.0-rc4 \nanything after\n");
  assert.equal(await installedRelease(file), "1.0.0-rc4");
  assert.equal(await installedRelease(join(scratch, "none")), "");
});

// A daemon with the package's settings and the ISO's file where a test says.
async function box(version: string, channel: string, release: string | null): Promise<string> {
  const dir = mkdtempSync(join(scratch, "box-"));
  const settingsFile = join(dir, "settings");
  writeFileSync(settingsFile, `ORIGAITV_VERSION=${version}\nORIGAITV_CHANNEL=${channel}\n`);
  const releaseFile = join(dir, "release");
  if (release !== null) writeFileSync(releaseFile, `${release}\n`);
  const daemon = new Daemon({ root: ROOT, state: join(dir, "state"), port: 0, log: () => {}, builtins: null, settingsFile, releaseFile, channelFile: join(dir, "channel") });
  daemons.push(daemon);
  return `http://127.0.0.1:${await daemon.listen()}`;
}

test("T30.3 the TV's state says the release beside the build, in home, state and health", async () => {
  const url = await box("0.2.0.r1061.g91b63a2e0", "edge", "1.0.0-rc4");
  for (const path of ["/api/home", "/api/state", "/health"]) {
    const data = (await (await fetch(`${url}${path}`)).json()) as { version: string; release: string | null; channel: string };
    assert.equal(data.version, "0.2.0.r1061.g91b63a2e0", path);
    assert.equal(data.release, "1.0.0-rc4", path);
    assert.equal(data.channel, "edge", path);
  }
});

test("T30.3 with no ISO's file, an edge build has no release, and a stable one is its own", async () => {
  const edge = await box("0.2.0.r1061.g91b63a2e0", "edge", null);
  assert.equal(((await (await fetch(`${edge}/api/home`)).json()) as { release: string | null }).release, null);
  const stable = await box("1.0.0", "stable", null);
  assert.equal(((await (await fetch(`${stable}/api/home`)).json()) as { release: string | null }).release, "1.0.0");
});
