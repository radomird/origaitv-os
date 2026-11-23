// Which release of OrigaiTV a TV runs, for Settings, System (ADR-132).
//
// A release's version is plain: 1.0.0, or 1.0.0-rc4 for a candidate. The
// package says it on stable, where each update is a release. An edge build
// says where it was made instead, like 0.2.0.r1061.g91b63a2e0, so the
// release a box runs is the one its USB stick was: the ISO writes that to
// /etc/origaitv/release as it installs. A box with neither, such as one
// installed from an edge ISO, or a checkout, has no release, only its build.

import { readFile } from "node:fs/promises";

export const RELEASE_FILE = "/etc/origaitv/release";

// 1.0.0 or 1.0.0-rc4, with no leading zeros, the way the release tags are
// written (origaitv-iso's bin/origaitv-iso-tag).
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc[1-9]\d*)?$/;

export function isRelease(version: string): boolean {
  return RELEASE.test(version);
}

// The release a box runs: the package's own version when it's a release's,
// or else the release it was installed from, or null.
export function releaseOf(version: string, installed: string): string | null {
  if (isRelease(version)) return version;
  return isRelease(installed) ? installed : null;
}

// The release the ISO wrote, as its first line, or "" with none.
export async function installedRelease(file = RELEASE_FILE): Promise<string> {
  return (await readFile(file, "utf8").catch(() => "")).split("\n")[0].trim();
}
