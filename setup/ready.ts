// Getting ready (board 35, ADR-025, S5.6): once the box is online it brings
// itself up to date first, so every screen after this one comes from the
// newest release. It asks the screen daemon for the update check, and when
// there's a newer OrigaiTV or Omarchy, or any system update waiting, for the
// same install Settings → Updates runs: a backup, the packages, migrations,
// and a restart for a new kernel. A fresh box from an older stick needs the
// system's packages new too, or the games picked later won't install. The
// install restarts OrigaiTV, so this page loads again from the new release
// and carries on here; one that needs the box to restart comes back here
// after it. A check or an install that doesn't work doesn't hold setup up:
// it says why, carries on with the version it has, and Settings → Updates
// has the update later. One that stops giving news counts as not working
// after a while, and one that failed after a new kernel went in asks for a
// restart first, since the running kernel's modules are gone.
//
// With setup's own switch on (D3), it's one headline, one line and one bar,
// with no checklist and no continue: it moves on by itself once the update
// is done or isn't needed. Back to it later, it waits for OK.

import { screen, type UpdateProgress, type UpdateStatus } from "../launcher/api.ts";
import { asWritten, h } from "../launcher/dom.ts";
import { setup, type SetupInfo, type UpdateWhy } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// How long the check may take before setup carries on without it.
const CHECK_MS = 180_000;
// How long the screen shows it's up to date before moving on.
const ON_MS = 2000;
// How long an install may go without news before it counts as stopped: the
// time the daemon gives one too (daemon/server.ts). Timed by the page's own
// clock, which a restart or a clock set right can't move.
const STALL_MS = 15 * 60_000;

// Why the update didn't go ahead, on the line and in the bar.
const WHY: Record<UpdateWhy, [line: string, bar: string]> = {
  offline: ["Couldn't update. Your TV isn't online.", "Not online"],
  busy: ["Couldn't update. Another update is running.", "Another update is running"],
  untested: ["This update isn't ready yet. Settings has it later.", "Update not ready yet"],
  space: ["Couldn't update. Your TV is out of space.", "Out of space"],
  mirror: ["Couldn't update. Its files have moved. Try later in Settings.", "Update files moved"],
  halfway: ["The update stopped partway. Try again in Settings.", "Update stopped partway"],
  unchanged: ["Couldn't update. Try later in Settings.", "Couldn't update"],
  stalled: ["The update stopped answering. Try again in Settings.", "Update stopped answering"],
  cut: ["The update was cut off by a restart. Try again in Settings.", "Update cut off"],
  check: ["Couldn't check for updates. Try later in Settings.", "Couldn't check for updates"],
  start: ["Couldn't start the update. Try later in Settings.", "Couldn't start the update"],
  waiting: ["Your TV is up to date for now. Newer updates come later.", "Some updates aren't ready yet"],
};
const WHYS = Object.keys(WHY) as UpdateWhy[];
const why = (r: SetupInfo["setup"]["ready"]): UpdateWhy => r.why ?? "unchanged";

// A version without pacman's release, to compare.
const bare = (version: string | null) => (version ?? "").replace(/-\d+$/, "");
// A version as people read it: no package release or build after it.
const shown = (version: string | null) => bare(version).replace(/\.r\d+\.g[0-9a-f]+$/, "");

// Two versions as people read them, or as they are when that would look the
// same, as on edge, or for a package built again.
function versions(from: string | null, to: string | null): [string, string] {
  if (from === to || shown(from) !== shown(to)) return [shown(from), shown(to)];
  if (bare(from) !== bare(to)) return [bare(from), bare(to)];
  return [from ?? "", to ?? ""];
}

const fresh = (at: string | undefined, asked: string | null) => Boolean(at && asked && Date.parse(at) >= Date.parse(asked) - 2000);

// Whether the update brings another OrigaiTV, rather than the system's
// packages alone.
const moves = (r: SetupInfo["setup"]["ready"]) => Boolean(r.to && bare(r.to) !== bare(r.from));

// Whether the TV has restarted since the update was installed: the box's
// own boot id, not its clock, which can be wrong after a restart.
const restarted = (about: SetupInfo) => Boolean(about.setup.ready.boot && about.boot && about.setup.ready.boot !== about.boot);

// Whether an update that failed still needs the TV to restart, as after a
// new kernel went in, and the TV hasn't restarted since.
function mustRestart(about: SetupInfo, progress: UpdateProgress | null): boolean {
  const r = about.setup.ready;
  return r.update === "failed" && progress?.state === "failed" && progress.restart === true && fresh(progress.at, r.asked) && !restarted(about);
}

// A row of the checklist. A network's name comes as its own piece, so it
// keeps its capitals.
function row(mark: "x" | ">" | " " | "!", text: string | (string | Node)[], extra?: HTMLElement): HTMLElement {
  const words = typeof text === "string" ? [text] : text;
  return h("span", { class: `ready-row mark-${mark === " " ? "todo" : mark === "x" ? "done" : mark === ">" ? "now" : "bad"}` }, h("span", {}, h("b", {}, `[${mark}]`), " ", ...words), extra ?? "");
}

// A bar of 16 blocks, as the install dashboard draws one.
function blocks(percent: number): HTMLElement {
  const filled = Math.max(0, Math.min(16, Math.round((percent / 100) * 16)));
  return h("span", { class: "blocks", role: "img", "aria-label": `${Math.round(percent)} percent` }, h("b", {}, "█".repeat(filled)), "█".repeat(16 - filled));
}

// Getting ready as D3 draws it, with setup's own switch on.
export const ready2 = (ctx: Ctx): View => ready(ctx, true);

export function ready(ctx: Ctx, phase2 = false): View {
  const line = h("p", { class: phase2 ? "setup-line" : "ready-line" }, phase2 ? "Checking for updates" : "Updating first");
  const list = h("div", { class: phase2 ? "ready-bar" : "ready-list" });
  const go = h(
    "button",
    {
      class: "button primary ready-go hidden",
      "data-focus": true,
      "data-action": "continue",
      onclick: () => void (mustRestart(ctx.info, ctx.updates.progress as UpdateProgress | null) ? screen.power("restart", "") : next()),
    },
    "Continue",
  );
  const el = phase2
    ? h("div", { class: "setup-page d3 ready2" }, ...heading("origaitv update", "Getting ready", ctx.reduced()), line, list)
    : h("div", { class: "setup-page center" }, h("div", { class: "ready-head" }, ...heading("tv setup", "Getting ready", ctx.reduced()), line), list, go);
  // With setup's own switch on, OK moves on once there's nothing left to do.
  let done = false;

  let stopped = false;
  let busy = false;
  // The check is asked for again once when the screen opens on it, as after
  // the page loaded again partway: starting it twice does no harm.
  let askedHere = false;
  let moving = false;
  let leaving = 0;
  let timer = 0;
  // Whether the update ran while this screen was on, so it moves on by
  // itself once it's done. The first time through it moves on by itself
  // too, as after the page loaded again from the new release; back to it
  // later only shows continue.
  let ran = false;

  async function next(): Promise<void> {
    if (moving) return;
    moving = true;
    clearTimeout(leaving);
    await ctx.finish("ready");
  }

  function draw(about: SetupInfo): void {
    if (phase2) {
      draw2(about);
      return;
    }
    const r = about.setup.ready;
    const status = ctx.updates.status as UpdateStatus | null;
    const progress = ctx.updates.progress as UpdateProgress | null;
    const phone = about.phones[about.phones.length - 1];
    const rows = [
      about.network.online
        ? row("x", about.network.via === "ethernet" ? "Cable" : ["Wi-Fi · ", about.network.name ? asWritten(about.network.name) : "on"])
        : row(">", "Waiting for the network"),
      phone ? row("x", `Paired · ${phone}`) : row(" ", "Phone · pair one later in Settings"),
    ];
    const [from, to] = versions(r.from ?? about.running, r.to ?? status?.origaitv.available ?? null);
    if (!about.network.online || r.update === null || r.update === "checking") rows.push(row(">", "Checking for updates"));
    else if (r.update === "installing") {
      const now = fresh(progress?.at, r.asked) ? progress : null;
      const what = moves(r) ? `OrigaiTV ${from} to ${to}` : "System updates";
      rows.push(now?.state === "restarting" ? row(">", moves(r) ? `OrigaiTV ${to} · restarting` : "System updates · restarting") : row(">", what, blocks(now?.percent ?? 0)));
    } else if (r.update === "done") rows.push(row("x", moves(r) ? `OrigaiTV ${to}` : "System updates"));
    else if (r.update === "none") rows.push(row("x", `OrigaiTV ${from} · up to date${r.why === "waiting" ? " for now" : ""}`));
    else if (r.update === "failed") rows.push(row("!", `OrigaiTV ${from} · couldn't update`));
    else rows.push(row("x", `OrigaiTV ${from} · update later in Settings`));
    list.replaceChildren(...rows);

    const restart = mustRestart(about, progress);
    const finished = r.update !== null && !["checking", "installing"].includes(r.update);
    if (!finished) ran = true;
    line.textContent = !finished
      ? "Updating first"
      : restart
        ? "Your TV needs a restart to finish updating."
        : r.update === "failed" || r.why === "waiting"
          ? WHY[why(r)][0]
          : "Up to date";
    go.textContent = restart ? "Restart" : "Continue";
    ctx.status(finished ? said(r, phone, restart) : phone ? "Phone paired · setup continues after the update" : "Setup continues after the update");
    if (restart) {
      go.classList.remove("hidden");
      ctx.focus.set(go, false);
      return;
    }
    if (finished && go.classList.contains("hidden")) {
      go.classList.remove("hidden");
      ctx.focus.set(go, false);
      ctx.sounds.play("confirm");
      if (ran || !about.setup.finished.ready) leaving = window.setTimeout(() => void next(), ON_MS);
    }
  }

  // D3's getting ready: what's happening in one line, and one bar. Once
  // it's done, on by itself, the first time through.
  function draw2(about: SetupInfo): void {
    const r = about.setup.ready;
    const status = ctx.updates.status as UpdateStatus | null;
    const progress = ctx.updates.progress as UpdateProgress | null;
    const phone = about.phones[about.phones.length - 1];
    const [from, to] = versions(r.from ?? about.running, r.to ?? status?.origaitv.available ?? null);
    const finished = about.network.online && r.update !== null && !["checking", "installing"].includes(r.update);
    const restart = finished && mustRestart(about, progress);
    let percent = 0;
    if (!about.network.online) line.textContent = "Waiting for the network";
    else if (r.update === null || r.update === "checking") line.textContent = "Checking for updates";
    else if (r.update === "installing") {
      const now = fresh(progress?.at, r.asked) ? progress : null;
      percent = now?.percent ?? 0;
      line.textContent = now?.state === "restarting" ? "Restarting your TV…" : "Updating your TV. It can take a few minutes and restart once.";
    } else {
      percent = 100;
      line.textContent =
        r.update === "done"
          ? moves(r)
            ? `OrigaiTV ${to} is ready`
            : "Your TV is up to date"
          : restart
            ? "Your TV needs a restart to finish updating."
            : r.update === "failed" || r.why === "waiting"
              ? WHY[why(r)][0]
              : `OrigaiTV ${from} is up to date`;
    }
    list.replaceChildren(blocks(percent));
    if (!finished) ran = true;
    ctx.status(finished ? said(r, phone, restart) : phone ? "Phone paired" : "Setup continues after the update");
    // A restart it needs comes first: OK restarts the TV, and setup carries
    // on after it.
    if (restart) return;
    if (finished && !done) {
      done = true;
      ctx.sounds.play("confirm");
      if (ran || !about.setup.finished.ready) leaving = window.setTimeout(() => void next(), ON_MS);
      else ctx.status("Continue");
    }
  }

  // What the bar says once it's finished: why it didn't update, or that it
  // needs a restart, then the phone.
  function said(r: SetupInfo["setup"]["ready"], phone: string | undefined, restart: boolean): string {
    const news = restart ? "Press OK to restart" : r.update === "failed" || r.why === "waiting" ? WHY[why(r)][1] : "";
    return [news, phone ? "Phone paired" : ""].filter(Boolean).join(" · ");
  }

  // The last news the install gave, and when the page heard it.
  let news = "";
  let heard = performance.now();

  // A reason from the install, if it's one setup knows.
  const reason = (progress: UpdateProgress | null): UpdateWhy => (WHYS.includes(progress?.reason as UpdateWhy) ? (progress?.reason as UpdateWhy) : "unchanged");

  // One look at where things are, and the next move.
  async function tick(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const about = await ctx.refresh();
      if (stopped) return;
      const r = about.setup.ready;
      const status = ctx.updates.status as UpdateStatus | null;
      const progress = ctx.updates.progress as UpdateProgress | null;
      if (!about.network.online) {
        // nothing to do until it is
      } else if (r.update === null) {
        if (about.pin) about.setup = await setup.ready({ update: "skipped", from: about.running });
        else {
          askedHere = true;
          about.setup = await setup.ready({ update: "checking", from: about.running, to: null });
          const reply = await screen.checkUpdates();
          if (!reply.ok) about.setup = await setup.ready({ update: "failed", why: "check" });
        }
      } else if (r.update === "checking") {
        if (!askedHere) {
          askedHere = true;
          about.setup = await setup.ready({ update: "checking" });
          const reply = await screen.checkUpdates();
          if (!reply.ok) about.setup = await setup.ready({ update: "failed", why: "check" });
        } else if (status && fresh(status.checked_at, r.asked)) {
          const any = Boolean(status.origaitv.available || status.omarchy.available || status.packages > 0);
          const from = status.origaitv.installed ?? about.running;
          if (!status.ok) about.setup = await setup.ready({ update: "failed", from: status.origaitv.installed ?? r.from, why: "check" });
          // The nightly run hasn't passed what's waiting yet, so the TV's
          // update would stop before it changed anything (bin/origaitv-tested).
          // Setup carries on with what it has, and says so.
          else if (any && status.waiting) about.setup = await setup.ready({ update: "none", from, to: from, why: "waiting" });
          else if (!any) about.setup = await setup.ready({ update: "none", from, to: from });
          else {
            about.setup = await setup.ready({ update: "installing", from, to: status.origaitv.available ?? from });
            const reply = await screen.installUpdate("");
            if (!reply.ok) about.setup = await setup.ready({ update: "failed", why: "start" });
          }
        } else if (r.asked && Date.now() - Date.parse(r.asked) > CHECK_MS) about.setup = await setup.ready({ update: "failed", why: "check" });
      } else if (r.update === "installing") {
        const now = progress && fresh(progress.at, r.asked) ? progress : null;
        const latest = now ? `${now.state} ${now.step} ${now.percent} ${now.at}` : "";
        if (latest !== news) {
          news = latest;
          heard = performance.now();
        }
        // The daemon restarted on the new package, as the install does at its
        // end: it's in. An update of the system's packages alone leaves
        // OrigaiTV's version as it was, so only the install's own word says
        // it's done, and a box that restarted for a new kernel comes back on
        // another boot with the install still saying it's restarting.
        if (moves(r) && about.running === r.to) about.setup = await setup.ready({ update: "done" });
        else if (now?.state === "failed") about.setup = await setup.ready({ update: "failed", why: reason(now) });
        else if (now?.state === "done") about.setup = await setup.ready({ update: "done" });
        else if (now?.state === "restarting" && restarted(about)) about.setup = await setup.ready({ update: "done" });
        // The TV started again in the middle of it, as after a power cut:
        // the update isn't running any more, so there's nothing to wait for.
        else if (restarted(about)) about.setup = await setup.ready({ update: "failed", why: "cut" });
        // No news for as long as the daemon gives an install: the update
        // never started, or stopped without saying so. A running update says
        // so every minute, however long its download.
        else if (performance.now() - heard > STALL_MS) about.setup = await setup.ready({ update: "failed", why: "stalled" });
      }
      ctx.info = about;
      draw(about);
    } catch (error) {
      // The daemon restarts during an install; the next look sees it back.
      console.warn(`getting ready: ${(error as Error).message}`);
    } finally {
      busy = false;
    }
  }

  draw(ctx.info);
  void tick();
  timer = window.setInterval(() => void tick(), 1000);

  return {
    el,
    info: "Setup continues after the update",
    // With setup's own switch on, OK carries on once it's done.
    act: (action) => {
      if (action !== "ok") return false;
      // A failed update that still needs a restart: OK restarts the TV.
      if (mustRestart(ctx.info, ctx.updates.progress as UpdateProgress | null)) {
        void screen.power("restart", "");
        return true;
      }
      if (!phase2 || !done) return false;
      void next();
      return true;
    },
    heard(event) {
      if (event === "updates") void tick();
    },
    // Back waits while the box updates itself.
    stay: () => {
      const r = ctx.info.setup.ready;
      return r.update === "checking" || r.update === "installing";
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(leaving);
    },
  };
}
