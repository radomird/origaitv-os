// Which release a TV runs, for Settings, System (T30.3's unit half): the
// package's version on stable, the release its ISO wrote while it runs the
// build that ISO carried, and once edge has moved it on, the release it was
// installed from. On edge the build's own version goes beside it, never in
// its place.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { installedRelease, isRelease, running } from "../../../daemon/release.ts";
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

// Edge counts from the last release or candidate, so a build is named after
// one: 1.0.0rc6.r12 is twelve commits after 1.0.0-rc6.
test("T30.3 an edge build named after a candidate or a release is still a build, never a release", () => {
  for (const version of ["1.0.0rc6.r0.g8880c58c5", "1.0.0rc6.r12.g91b63a2e0", "1.0.0rc10.r0.g91b63a2e0", "1.0.0.r0.g91b63a2e0", "1.0.0.r3.g91b63a2e0", "1.0.1rc1.r0.g91b63a2e0", "1.0.0rc6"]) {
    assert.equal(isRelease(version), false, version);
  }
});

test("T30.3 the 1.0.0-rc7 ISO carries a build named after rc6, and the TV runs 1.0.0-rc7 until edge moves it on", () => {
  const rc7 = { release: "1.0.0-rc7", build: "1.0.0rc6.r12.g91b63a2e0" };
  assert.deepEqual(running("1.0.0rc6.r12.g91b63a2e0", rc7), { release: "1.0.0-rc7", installedFrom: "1.0.0-rc7" });
  assert.deepEqual(running("1.0.0rc7.r2.g0c4f00d1e", rc7), { release: null, installedFrom: "1.0.0-rc7" });
  // A box from before, updated from a 0.2.0 build to one named after rc6.
  assert.deepEqual(running("1.0.0rc6.r0.g8880c58c5", { release: "1.0.0-rc6", build: "0.2.0.r1157.g8880c58c5" }), { release: null, installedFrom: "1.0.0-rc6" });
  // On stable, 1.0.0 itself.
  assert.deepEqual(running("1.0.0", rc7), { release: "1.0.0", installedFrom: "1.0.0-rc7" });
  // With no ISO's file, it has no release, only its build.
  assert.deepEqual(running("1.0.0rc6.r12.g91b63a2e0", { release: "", build: "" }), { release: null, installedFrom: null });
});

const RC4 = { release: "1.0.0-rc4", build: "0.2.0.r1061.g91b63a2e0" };

test("T30.3 an edge box still on the build the 1.0.0-rc4 ISO carried runs 1.0.0-rc4", () => {
  assert.deepEqual(running("0.2.0.r1061.g91b63a2e0", RC4), { release: "1.0.0-rc4", installedFrom: "1.0.0-rc4" });
});

test("T30.3 once edge moves it past that build, it runs edge, installed from 1.0.0-rc4", () => {
  assert.deepEqual(running("0.2.0.r1072.g0c4f00d1e", RC4), { release: null, installedFrom: "1.0.0-rc4" });
});

test("a box with the one-line file from before still runs its release", () => {
  assert.deepEqual(running("0.2.0.r1072.g0c4f00d1e", { release: "1.0.0-rc4", build: "" }), { release: "1.0.0-rc4", installedFrom: "1.0.0-rc4" });
});

test("T30.3 on stable the package's release wins over the ISO's", () => {
  assert.deepEqual(running("1.0.0", RC4), { release: "1.0.0", installedFrom: "1.0.0-rc4" });
  assert.deepEqual(running("1.0.1", { release: "", build: "" }), { release: "1.0.1", installedFrom: null });
});

test("T30.3 a box from an edge ISO, or a checkout, has no release", () => {
  const none = { release: null, installedFrom: null };
  assert.deepEqual(running("0.2.0.r1061.g91b63a2e0", { release: "", build: "" }), none);
  assert.deepEqual(running("dev", { release: "", build: "" }), none);
  assert.deepEqual(running("dev", { release: "not a version", build: "dev" }), none);
});

test("the ISO's file is read a line each, and a missing one is empty", async () => {
  const file = join(scratch, "release");
  writeFileSync(file, " 1.0.0-rc4 \n0.2.0.r1061.g91b63a2e0\n");
  assert.deepEqual(await installedRelease(file), RC4);
  writeFileSync(file, "1.0.0-rc4\n");
  assert.deepEqual(await installedRelease(file), { release: "1.0.0-rc4", build: "" });
  assert.deepEqual(await installedRelease(join(scratch, "none")), { release: "", build: "" });
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

type State = { version: string; release: string | null; installedFrom: string | null; channel: string };

test("T30.3 the TV's state says the release beside the build, in home, state and health", async () => {
  const url = await box("0.2.0.r1061.g91b63a2e0", "edge", "1.0.0-rc4\n0.2.0.r1061.g91b63a2e0\n");
  for (const path of ["/api/home", "/api/state", "/health"]) {
    const data = (await (await fetch(`${url}${path}`)).json()) as State;
    assert.equal(data.version, "0.2.0.r1061.g91b63a2e0", path);
    assert.equal(data.release, "1.0.0-rc4", path);
    assert.equal(data.installedFrom, "1.0.0-rc4", path);
    assert.equal(data.channel, "edge", path);
  }
});

test("T30.3 once updated past the ISO's build, the state has no release, and still says where it was installed from", async () => {
  const url = await box("0.2.0.r1072.g0c4f00d1e", "edge", "1.0.0-rc4\n0.2.0.r1061.g91b63a2e0\n");
  for (const path of ["/api/home", "/api/state", "/health"]) {
    const data = (await (await fetch(`${url}${path}`)).json()) as State;
    assert.equal(data.release, null, path);
    assert.equal(data.installedFrom, "1.0.0-rc4", path);
  }
});

test("T30.3 with no ISO's file, an edge build has no release, and a stable one is its own", async () => {
  const edge = (await (await fetch(`${await box("0.2.0.r1061.g91b63a2e0", "edge", null)}/api/home`)).json()) as State;
  assert.deepEqual([edge.release, edge.installedFrom], [null, null]);
  const stable = (await (await fetch(`${await box("1.0.0", "stable", null)}/api/home`)).json()) as State;
  assert.deepEqual([stable.release, stable.installedFrom], ["1.0.0", null]);
});

// origaitv version, by the same rule: a line under the package's.
function version(settings: string, release: string | null): string {
  const dir = mkdtempSync(join(scratch, "cli-"));
  writeFileSync(join(dir, "settings"), settings);
  if (release !== null) writeFileSync(join(dir, "release"), release);
  const said = spawnSync("bash", [join(ROOT, "bin/origaitv-version")], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin", ORIGAITV_PATH: dir, ORIGAITV_RELEASE_FILE: join(dir, "release") } });
  assert.equal(said.status, 0, said.stderr);
  return said.stdout.trim();
}

test("T30.3 origaitv version says the release, then edge, installed from it, and nothing more on stable or with no release", () => {
  const edge = (build: string) => `ORIGAITV_VERSION=${build}\nORIGAITV_CHANNEL=edge\n`;
  const rc4 = "1.0.0-rc4\n0.2.0.r1061.g91b63a2e0\n";
  assert.equal(version(edge("0.2.0.r1061.g91b63a2e0"), rc4), "OrigaiTV 0.2.0.r1061.g91b63a2e0 (edge)\nRelease 1.0.0-rc4");
  assert.equal(version(edge("0.2.0.r1072.g0c4f00d1e"), rc4), "OrigaiTV 0.2.0.r1072.g0c4f00d1e (edge)\nEdge channel, installed from 1.0.0-rc4");
  assert.equal(version(edge("0.2.0.r1072.g0c4f00d1e"), "1.0.0-rc4\n"), "OrigaiTV 0.2.0.r1072.g0c4f00d1e (edge)\nRelease 1.0.0-rc4");
  assert.equal(version(edge("0.2.0.r1061.g91b63a2e0"), null), "OrigaiTV 0.2.0.r1061.g91b63a2e0 (edge)");
  assert.equal(version("ORIGAITV_VERSION=1.0.0\nORIGAITV_CHANNEL=stable\n", rc4), "OrigaiTV 1.0.0 (stable)");
});

test("T30.3 origaitv version says the same for a build named after a candidate", () => {
  const edge = (build: string) => `ORIGAITV_VERSION=${build}\nORIGAITV_CHANNEL=edge\n`;
  const rc7 = "1.0.0-rc7\n1.0.0rc6.r12.g91b63a2e0\n";
  assert.equal(version(edge("1.0.0rc6.r12.g91b63a2e0"), rc7), "OrigaiTV 1.0.0rc6.r12.g91b63a2e0 (edge)\nRelease 1.0.0-rc7");
  assert.equal(version(edge("1.0.0rc7.r2.g0c4f00d1e"), rc7), "OrigaiTV 1.0.0rc7.r2.g0c4f00d1e (edge)\nEdge channel, installed from 1.0.0-rc7");
  assert.equal(version(edge("1.0.0.r0.g0c4f00d1e"), rc7), "OrigaiTV 1.0.0.r0.g0c4f00d1e (edge)\nEdge channel, installed from 1.0.0-rc7");
  assert.equal(version(edge("1.0.0rc6.r12.g91b63a2e0"), null), "OrigaiTV 1.0.0rc6.r12.g91b63a2e0 (edge)");
});
