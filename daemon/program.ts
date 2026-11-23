// Whether the program an official native app opens is on the box: Steam's
// package for Steam, umu-launcher for Battle.net, GeForce NOW's flatpak. The
// app itself is a small folder the daemon reads, and its program is a
// package root installs after it (bin/origaitv-app-package). When that
// didn't happen, the app isn't really on the TV: home shows no tile for it,
// and Settings' Games page offers to add it again.
//
// It reads what pacman and flatpak keep about what's installed, and nothing
// else. Where there's no pacman at all, which is a developer's computer, not
// a TV, every program counts as there.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ProgramPlaces {
  // pacman's record of what's installed: one folder a package.
  pacman: string;
  // flatpak's system-wide apps: one folder an app.
  flatpak: string;
}

export const PROGRAM_PLACES: ProgramPlaces = { pacman: "/var/lib/pacman/local", flatpak: "/var/lib/flatpak/app" };

export interface NativePackage {
  package?: { pacman?: string; flatpak?: string };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/;

// pacman's folder names, read again only when the folder changes, as it
// does with every install and removal.
const listed = new Map<string, { mtime: number; names: Set<string> }>();
function installedPackages(dir: string): Set<string> | null {
  let mtime: number;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch {
    return null;
  }
  const known = listed.get(dir);
  if (known?.mtime === mtime) return known.names;
  const names = new Set<string>();
  try {
    for (const entry of readdirSync(dir)) {
      // <name>-<version>-<release>: the name is all but the last two parts.
      const parts = entry.split("-");
      if (parts.length >= 3) names.add(parts.slice(0, -2).join("-"));
    }
  } catch {
    return null;
  }
  listed.set(dir, { mtime, names });
  return names;
}

// Whether the app's program is installed. An app that names no package has
// nothing to wait for.
export function programHere(app: NativePackage, places: ProgramPlaces = PROGRAM_PLACES): boolean {
  const pacman = installedPackages(places.pacman);
  if (!pacman) return true;
  const want = app.package ?? {};
  if (want.pacman && NAME.test(want.pacman) && !pacman.has(want.pacman)) return false;
  if (want.flatpak && NAME.test(want.flatpak) && !existsSync(join(places.flatpak, want.flatpak))) return false;
  return true;
}
