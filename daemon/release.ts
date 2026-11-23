// Which release of OrigaiTV a TV runs, for Settings, System (ADR-132).
//
// A release's version is plain: 1.0.0, or 1.0.0-rc4 for a candidate. The
// package says it on stable, where each update is a release. An edge build
// says where it was made instead, like 0.2.0.r1061.g91b63a2e0. So the ISO
// writes what it installed to /etc/origaitv/release: the release on its first
// line, and the build it carried on its second. While the box still runs
// that build, it runs that release. Once an update on edge moves it past
// that build, it runs edge, installed from that release. A file from before
// the second line has only the release, and the box counts as running it.
// A box with no file, such as one installed from an edge ISO, or a
// checkout, has no release, only its build.

import { readFile } from "node:fs/promises";

export const RELEASE_FILE = "/etc/origaitv/release";

// 1.0.0 or 1.0.0-rc4, with no leading zeros, the way the release tags are
// written (origaitv-iso's bin/origaitv-iso-tag).
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc[1-9]\d*)?$/;

export function isRelease(version: string): boolean {
  return RELEASE.test(version);
}

// What the ISO installed: its release, and the build it carried ("" in a
// file from before the second line).
export interface Installed {
  release: string;
  build: string;
}

// What a TV runs: the release, while it runs one, and the release it was
// installed from, if the ISO said. Edge, installed from 1.0.0-rc4, is a
// null release with installedFrom 1.0.0-rc4.
export interface Running {
  release: string | null;
  installedFrom: string | null;
}

export function running(version: string, installed: Installed): Running {
  const from = isRelease(installed.release) ? installed.release : null;
  // On stable the package's own version is the release.
  if (isRelease(version)) return { release: version, installedFrom: from };
  if (!from) return { release: null, installedFrom: null };
  // Still the build the ISO carried, or a file that doesn't say which.
  if (!installed.build || installed.build === version) return { release: from, installedFrom: from };
  return { release: null, installedFrom: from };
}

// The ISO's file, a line each, or empty lines with none.
export async function installedRelease(file = RELEASE_FILE): Promise<Installed> {
  const [release = "", build = ""] = (await readFile(file, "utf8").catch(() => "")).split("\n").map((line) => line.trim());
  return { release, build };
}
