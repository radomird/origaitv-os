// Paired phones (ADR-007, ADR-008, stage 4): the TV shows a one-time code,
// and a QR code with the address of the box's phone companion and a longer
// secret. A phone proves it has one of the two without sending it, and the
// phone and the box agree on a key of the phone's own (see
// daemon/phone-channel.ts), which signs and seals what the phone sends from
// then on. The keys are kept in the daemon's own state, in a file only it
// reads, and Settings → Phones forgets a phone.
//
// A code lasts 10 minutes and pairs one phone. Five wrong tries end it, so
// the TV has to show a new one.
//
// A phone that set the TV up from the USB stick has a secret from the stick
// too. The stick gives it only to the phone on its own Wi-Fi, and hands it
// to the installed TV (first boot puts it in the daemon's state). Until
// setup is done, that secret pairs that one phone the way the QR code's
// does, with no code on the TV, so nobody scans twice. It lasts a day from
// the TV's first start, set up or not: after that it goes, setup shows its
// own code, and a phone that comes back later scans that.

import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import { b64u, hmac, INFO, phoneKey, same, unb64u, x25519Pair, x25519Shared } from "./phone-channel.ts";

// No 0 and O, or 1, I and L, which look alike on a TV.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
export const CODE_MS = 10 * 60_000;
const CODE_TRIES = 5;
const NAME_MAX = 30;
// How long the stick's secret lasts from the TV's first start.
export const STICK_MS = 24 * 60 * 60_000;

// The TV's clocks: which boot this is, how long since it, and the wall
// clock. The first never jumps within a boot. The wall clock can be wrong
// at the first start, before the TV has the time from the network.
export interface Clock {
  boot: string;
  sinceBootMs: number;
  wallMs: number;
}

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

// How much of the stick secret's day is used, kept in its file: the boot
// counted in, how far into that boot it started counting, what was used
// before that boot, the wall clock's time for the first start as best
// known, and the most seen used so far.
interface FirstStart {
  boot: string;
  sinceBootMs: number;
  baseMs: number;
  wallMs: number;
  usedMs: number;
}

export interface Phone {
  id: string;
  name: string;
  pairedAt: string;
  seenAt?: string;
}

interface Stored extends Phone {
  key: string; // the phone's key, 32 bytes in base64
  // Paired with the TV's code over the TV's own Wi-Fi during setup, while
  // the stick's page phone was still to come. On an iPhone that's the sheet
  // for Wi-Fi sign-ins, which forgets its key once it closes, and the same
  // phone pairs again later from the stick's link. See pair().
  setupHotspot?: true;
}

// What a phone sends to pair: its one-time public key, and proof that it
// has the QR code's secret or the code on the TV.
export interface PairRequest {
  key?: unknown;
  name?: unknown;
  proof?: unknown;
}

// What the box answers: the phone's id, the box's one-time public key, and
// proof that the box came to the same key. When the box has an id (see
// daemon/announce.ts) the answer has that too, and the proof covers it.
export interface Paired {
  id: string;
  key: string;
  confirm: string;
  phone: Phone;
  boxId?: string;
}

export interface PhonesOptions {
  path: string; // <state>/phones.json
  // <state>/stick-pairing.json: the secret the USB stick handed over, as
  // {"secret": "<16 bytes, base64url>", "wait": true}, until a phone pairs
  // with it. wait is false when only the stick's page took it: that phone
  // opens a link in its own browser later, so setup shows its code meanwhile.
  handed?: string;
  // The TV's clocks, a test's own in place of the system's.
  clock?: () => Clock;
  now?: () => number;
  // Random bytes and a random whole number below `max` of a test's own, in
  // place of the system's.
  random?: (length: number) => Buffer;
  randomInt?: (max: number) => number;
}

const usable = (phone: Stored) => typeof phone?.id === "string" && typeof phone.key === "string" && Buffer.from(phone.key, "base64").length === 32;

export class Phones {
  private path: string;
  private handedPath: string | undefined;
  private now: () => number;
  private given: ((length: number) => Buffer) | undefined;
  private random: (length: number) => Buffer;
  private randomInt: (max: number) => number;
  private pending: { code: string; secret: Buffer; until: number; tries: number } | null = null;
  private seen = new Map<string, string>();
  private clock: () => Clock;

  constructor(options: PhonesOptions) {
    this.path = options.path;
    this.handedPath = options.handed;
    this.now = options.now ?? Date.now;
    this.given = options.random;
    this.random = options.random ?? randomBytes;
    this.randomInt = options.randomInt ?? randomInt;
    this.clock = options.clock ?? (() => ({ boot: bootId(), sinceBootMs: uptime() * 1000, wallMs: this.now() }));
    // The daemon starts with the TV, so this is the first start's mark.
    this.readHanded();
  }

  private read(): Stored[] {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      const phones: Stored[] = Array.isArray(data?.phones) ? data.phones : [];
      // A phone paired before phones had keys has only a token's hash here.
      // Nothing takes a token any more, so it goes, and that phone pairs
      // again.
      const kept = phones.filter(usable);
      if (kept.length !== phones.length) this.write(kept);
      return kept;
    } catch {
      return [];
    }
  }

  private write(phones: Stored[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.next`, `${JSON.stringify({ phones }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${this.path}.next`, this.path);
  }

  list(): Phone[] {
    return this.read().map(({ key: _key, setupHotspot: _setup, ...phone }) => ({ ...phone, seenAt: this.seen.get(phone.id) ?? phone.seenAt }));
  }

  // The secret the USB stick handed over, while no phone has paired with it,
  // and whether setup waits for that phone. Its day is counted here: the
  // first read marks the first start, and once a day has gone by it goes.
  private readHanded(): { secret: Buffer; wait: boolean } | null {
    if (!this.handedPath) return null;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(this.handedPath, "utf8"));
    } catch {
      return null;
    }
    const secret = unb64u(data?.secret, 16);
    if (!secret) return null;
    if (this.used(data) >= STICK_MS) {
      this.dropStick();
      return null;
    }
    // A file from before wait was written means an app's phone: wait.
    return { secret, wait: data?.wait !== false };
  }

  // How much of the secret's day has gone, keeping the count in the file.
  // Within a boot, it's what was used before that boot plus the time since,
  // by the clock that never jumps, so a wall clock set right or wrong in the
  // meantime changes nothing. At the first read in a new boot, the time the
  // TV was off is the wall clock against the first start's time, as best
  // known, and never less than what was used before. So a clock that's
  // wrong at the first start can't cut the day short or stretch it, and one
  // set back after a restart can't give it its hours back.
  private used(data: Record<string, unknown>): number {
    const now = this.clock();
    const mark = data.firstStart as FirstStart | undefined;
    const valid = mark && typeof mark.boot === "string" && [mark.sinceBootMs, mark.baseMs, mark.wallMs, mark.usedMs].every(Number.isFinite);
    let next: FirstStart;
    if (valid && mark.boot === now.boot && now.boot !== "") {
      const used = Math.max(mark.usedMs, mark.baseMs + now.sinceBootMs - mark.sinceBootMs);
      next = { ...mark, wallMs: now.wallMs - used, usedMs: used };
    } else {
      const used = valid ? Math.max(mark.usedMs, now.wallMs - mark.wallMs) : 0;
      next = { boot: now.boot, sinceBootMs: now.sinceBootMs, baseMs: used, wallMs: now.wallMs - used, usedMs: used };
    }
    // Written when it's new or a new boot, when the wall clock moved by more
    // than a minute, or every ten minutes of use, not on every read.
    if (!valid || next.boot !== mark.boot || Math.abs(next.wallMs - mark.wallMs) > 60_000 || next.usedMs - mark.usedMs >= 10 * 60_000) {
      try {
        writeFileSync(`${this.handedPath}.next`, `${JSON.stringify({ ...data, firstStart: next })}\n`, { mode: 0o600 });
        renameSync(`${this.handedPath}.next`, this.handedPath!);
      } catch {
        // Counted from what's known: the next read tries again.
      }
    }
    return next.usedMs;
  }

  // Whether a phone from the USB stick is still to pair. Setup asks, to
  // wait for it rather than show a code.
  waitingForStick(): boolean {
    return this.readHanded()?.wait === true;
  }

  // The stick's secret goes: a phone paired with it, or setup is done.
  dropStick(): void {
    if (this.handedPath) rmSync(this.handedPath, { force: true });
  }

  // A new code for the TV to show, in place of any before it.
  code(): { code: string; until: string } {
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[this.randomInt(ALPHABET.length)]).join("");
    this.pending = { code, secret: this.random(16), until: this.now() + CODE_MS, tries: 0 };
    return { code, until: new Date(this.pending.until).toISOString() };
  }

  // The code being shown, while it lasts.
  showing(): { code: string; until: string } | null {
    if (!this.pending || this.pending.until <= this.now()) return null;
    return { code: this.pending.code, until: new Date(this.pending.until).toISOString() };
  }

  // The secret that goes with the code on show, for the QR code only. It
  // rides in the part of the address a browser keeps to itself (after the
  // #), so it's never sent over the network and never on the TV as text.
  secret(): string | null {
    return this.pending && this.pending.until > this.now() ? b64u(this.pending.secret) : null;
  }

  // A phone that scanned the QR code or typed the TV's code: it sends a
  // public key and proof that it has the secret or the code, never either
  // of them. A wrong proof is a wrong try. The answer has the box's public
  // key, and both sides now hold the phone's key without it having crossed
  // the network.
  //
  // `boxId` is the box's id, when it has one. The answer then says it, and
  // the proof covers it under a label of its own. So a proof made with an
  // id never fits an answer without one, or one with another id, and a
  // proof made without never fits an answer that has one.
  //
  // `stick` says whether the USB stick's secret may pair: only until setup
  // is done. Past that, it goes.
  //
  // `overHotspot` says the phone came over the TV's own Wi-Fi. On a TV with
  // no cable, the phone that set it up from the stick's page pairs there
  // with the TV's code to finish setup, in the sheet for Wi-Fi sign-ins on
  // an iPhone. Later it opens the stick's link in its own browser and pairs
  // again. That pairing takes the place of the first, by the same name, so
  // the TV lists the phone once.
  //
  // The answer says which phone that was, in `replaces`, for the daemon to
  // forget its session and pads as it does any forgotten phone's. It's never
  // sent to the phone.
  pair(request: PairRequest | undefined, boxId?: string, stick = false, overHotspot = false): (Paired & { replaces?: string }) | { error: string } {
    const live = this.pending && this.pending.until > this.now() ? this.pending : null;
    if (!stick && this.handedPath) this.dropStick();
    const stickPhone = stick ? this.readHanded() : null;
    const handed = stickPhone?.secret ?? null;
    if (!live && !handed) return { error: "That code ran out. Pair again from your TV." };
    // A wrong try counts against the code on show. The stick's secret is 16
    // random bytes, which nobody guesses, so it has no tries to run out of.
    const wrong = () => {
      if (live) {
        live.tries++;
        if (live.tries >= CODE_TRIES) this.pending = null;
      }
      return { error: "That isn't the code on your TV" };
    };
    const theirs = unb64u(request?.key, 32);
    const proof = unb64u(request?.proof, 32);
    if (!theirs || !proof) return wrong();
    // Every one is worked out and compared every time, so how long it takes
    // says nothing about which was tried.
    const none = Buffer.alloc(16);
    const bySecret = same(proof, hmac(live?.secret ?? none, INFO.pair, theirs)) && live !== null;
    const byCode = same(proof, hmac(Buffer.from(live?.code ?? ""), INFO.pair, theirs)) && live !== null;
    const byStick = same(proof, hmac(handed ?? none, INFO.pair, theirs)) && handed !== null;
    if (!bySecret && !byCode && !byStick) return wrong();
    const ours = x25519Pair(this.given?.(32));
    const shared = x25519Shared(ours.secret, theirs);
    if (!shared) return wrong();
    const k = byStick ? handed! : bySecret ? live!.secret : Buffer.from(live!.code);
    const key = phoneKey(shared, k, theirs, ours.public);
    // The stick's secret pairs one phone, and leaves the code on show, if
    // there is one, for another.
    if (byStick) this.dropStick();
    else this.pending = null;
    const name = request?.name;
    const label = (typeof name === "string" && name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, NAME_MAX)) || "a phone";
    const phone: Phone = { id: `p-${this.random(4).toString("hex")}`, name: label, pairedAt: new Date(this.now()).toISOString() };
    // Only a pairing marked as made by code over the TV's own Wi-Fi during
    // setup is ever replaced. Two of those with the same name can't be told
    // apart, so it's the latest.
    const first = byStick ? this.read().filter((p) => p.setupHotspot && p.name === label).pop() : undefined;
    if (first) this.forget(first.id);
    let phones = this.read();
    if (byStick) phones = phones.map(({ setupHotspot: _setup, ...p }) => p);
    const mark = !byStick && overHotspot && stickPhone?.wait === false ? { setupHotspot: true as const } : {};
    this.write([...phones, { ...phone, key: key.toString("base64"), ...mark }]);
    const replaces = first ? { replaces: first.id } : {};
    if (boxId === undefined) return { id: phone.id, key: b64u(ours.public), confirm: b64u(hmac(key, INFO.pairBox, theirs, ours.public)), phone, ...replaces };
    return { id: phone.id, key: b64u(ours.public), confirm: b64u(hmac(key, INFO.pairBoxId, theirs, ours.public, boxId)), phone, boxId, ...replaces };
  }

  // A paired phone and its key, by its id, or null.
  key(id: unknown): { phone: Phone; key: Buffer } | null {
    if (typeof id !== "string") return null;
    const found = this.read().find((phone) => phone.id === id);
    if (!found) return null;
    const { key, ...phone } = found;
    return { phone, key: Buffer.from(key, "base64") };
  }

  // A request this phone signed just came.
  saw(id: string): void {
    this.seen.set(id, new Date(this.now()).toISOString());
  }

  forget(id: string): boolean {
    const phones = this.read();
    const kept = phones.filter((phone) => phone.id !== id);
    if (kept.length === phones.length) return false;
    this.write(kept);
    return true;
  }
}
