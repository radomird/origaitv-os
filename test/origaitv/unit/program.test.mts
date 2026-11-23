// Whether an official native app's program is on the box, from what pacman
// and flatpak keep about what's installed. Without it, the app isn't really
// on the TV: home shows no tile, and Settings offers to add it again.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { programHere } from "../../../daemon/program.ts";

const scratch = mkdtempSync(join(tmpdir(), "origaitv-program-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const places = { pacman: join(scratch, "local"), flatpak: join(scratch, "flatpak") };

test("with no pacman at all, every program counts as there", () => {
  assert.equal(programHere({ package: { pacman: "steam" } }, places), true);
});

test("a pacman package is there once pacman has it, by its whole name", () => {
  mkdirSync(join(places.pacman, "umu-launcher-1.2.9-1"), { recursive: true });
  mkdirSync(join(places.pacman, "steam-native-runtime-1.0.0.75-1"));
  assert.equal(programHere({ package: { pacman: "steam" } }, places), false, "steam-native-runtime isn't steam");
  assert.equal(programHere({ package: { pacman: "umu-launcher" } }, places), true);
  mkdirSync(join(places.pacman, "steam-1.0.0.85-1"));
  assert.equal(programHere({ package: { pacman: "steam" } }, places), true, "read again once the folder changes");
  rmSync(join(places.pacman, "steam-1.0.0.85-1"), { recursive: true });
  assert.equal(programHere({ package: { pacman: "steam" } }, places), false, "and gone with it");
});

test("a flatpak is there once flatpak has it, and an app with no package has nothing to wait for", () => {
  assert.equal(programHere({ package: { flatpak: "com.nvidia.geforcenow" } }, places), false);
  mkdirSync(join(places.flatpak, "com.nvidia.geforcenow"), { recursive: true });
  assert.equal(programHere({ package: { flatpak: "com.nvidia.geforcenow" } }, places), true);
  assert.equal(programHere({}, places), true);
});
