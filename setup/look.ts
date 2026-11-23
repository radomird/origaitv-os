// Setup's look step (ADR-063, D3), with the looks switch on: Terminal,
// Glass and Cinema by name down the left, and home in the focused one on the
// right, drawn by the launcher itself in a frame. OK on a name picks it and
// goes on to Fit to screen (setup/fit.ts), then the theme, step 11 of 12.
// Under the preview, with the sizes switch on, two sizes, normal and large
// (ADR-062): OK on one sets it, and the preview shows home at it. Where the TV has
// nothing of its own yet, the preview fills in with open movies
// (launcher/looks/showcase.ts).
// Settings → Themes and backgrounds changes both any time.

import { h } from "../launcher/dom.ts";
import { previewFrame } from "../launcher/looks/preview.ts";
import type { LookId, LookInfo, SizeId } from "../launcher/looks/looks.ts";
import { loadSizes, setSize, SIZE_NAMES } from "../launcher/size.ts";
import { NEEDS_PIN } from "./api.ts";
import { heading } from "./frame.ts";
import type { Ctx, View } from "./main.ts";

// Setup's two sizes, in the order they show, and what each is called.
const SETUP_SIZES: SizeId[] = ["standard", "larger"];
const SETUP_SIZE_NAMES: Partial<Record<SizeId, string>> = { standard: "Normal", larger: "Large" };

// The preview's width: home at 52 percent, so the sizes under it keep
// clear of the status bar.
const PREVIEW_WIDTH = 1000;

export async function look(ctx: Ctx): Promise<View> {
  const found = await fetch("/api/look")
    .then((response) => response.json() as Promise<{ look?: string; looks?: LookInfo[] }>)
    .catch(() => ({ look: "terminal", looks: [] as LookInfo[] }));
  let current = found.look ?? "terminal";
  const looks = (found.looks ?? []).filter((one): one is LookInfo => ["terminal", "glass", "cinema"].includes(one.id as LookId));
  const pick = async (one: LookInfo) => {
    const put = await ctx
      .guarded("the look", async (grant) => {
        const response = await fetch("/api/look", { method: "PUT", headers: { "Content-Type": "application/json", ...(grant ? { "X-OrigaiTV-Grant": grant } : {}) }, body: JSON.stringify({ look: one.id }) }).catch(() => null);
        if (response?.status === 403 && ((await response.json().catch(() => null)) as { pin?: boolean } | null)?.pin) throw new Error(NEEDS_PIN);
        return Boolean(response?.ok);
      })
      .catch(() => ({ value: false }));
    if (!put) return;
    if (!put.value) {
      ctx.sounds.play("failure");
      ctx.toast(`Couldn't use ${one.name}`, "fail");
      return;
    }
    current = one.id;
    // The size shown picked, if the TV isn't at it yet.
    if (display && display.size !== shownSize() && !(await pickSize(shownSize(), true))) return;
    ctx.sounds.play("confirm");
    // On to Fit to screen, right after the size (ADR-103), then the theme
    // and background, setup's next step. With the sizes off there's no
    // margin to fit.
    if (display) ctx.open("look/fit", "forward");
    else await ctx.finish("look");
  };

  // The looks by name, the one in use marked.
  const names = looks.map((one) =>
    h(
      "button",
      { class: `look-card setup-look-name${one.id === current ? " picked" : ""}`, "data-focus": true, "data-action": `look-${one.id}`, "data-look": one.id, onclick: () => void pick(one) },
      h("span", { class: "look-card-name" }, one.name),
    ),
  );

  // Home in each look, one over the other, and the focused one shown. They
  // all load at once, so moving between them shows each straight away.
  let shown = current;
  const stage = h("div", { class: "setup-look-stage", "aria-hidden": "true" });
  const drawFrames = (size: SizeId) =>
    stage.replaceChildren(
      ...looks.map((one) => {
        const frame = previewFrame(one.id as LookId, size, PREVIEW_WIDTH);
        frame.dataset.preview = one.id;
        frame.classList.toggle("on", one.id === shown);
        return frame;
      }),
    );
  const show = (id: string) => {
    shown = id;
    for (const frame of stage.children) (frame as HTMLElement).classList.toggle("on", (frame as HTMLElement).dataset.preview === id);
  };

  // Two sizes to pick from here, normal and large, the one the TV is at
  // marked: normal to start with. More on screen waits in Settings. None
  // with the sizes off, or on a TV that offers one.
  let display = await loadSizes();
  const sizesBox = h("div", { class: "setup-look-sizes", "data-sizes": "" });
  const offered = () => SETUP_SIZES.filter((one) => display?.sizes.includes(one));
  // The size shown picked: the TV's own when setup offers it, and normal
  // when it doesn't, as on a TV set to more on screen in Settings before
  // setup started again. Moving on from the step sets it.
  const shownSize = (): SizeId => {
    if (!display) return "standard";
    const list = offered();
    return list.includes(display.size) || !list.includes("standard") ? display.size : "standard";
  };
  const drawSizes = () => {
    if (!display || offered().length < 2) return sizesBox.replaceChildren();
    const at = shownSize();
    sizesBox.replaceChildren(
      h("span", { class: "setup-look-sizes-label" }, "Size"),
      ...offered().map((one) => h("button", { class: `chip${one === at ? " picked" : ""}`, "data-focus": true, "data-action": `size-${one}`, onclick: () => void pickSize(one) }, SETUP_SIZE_NAMES[one])),
    );
  };
  // A size picked, or set as the step moves on. True once the TV has it.
  const pickSize = async (one: SizeId, moving = false): Promise<boolean> => {
    if (!display || one === display.size) {
      if (!moving) ctx.sounds.play("confirm");
      return true;
    }
    const asked = await ctx
      .guarded("the size", async (grant) => {
        const answer = await setSize(one, grant);
        if (answer.error?.toLowerCase() === NEEDS_PIN) throw new Error(NEEDS_PIN);
        return answer;
      })
      .catch((error: Error) => ({ value: { error: error.message } as Awaited<ReturnType<typeof setSize>> }));
    if (!asked) return false;
    const set = asked.value;
    if (!set.state) {
      ctx.sounds.play("failure");
      ctx.toast(set.error ?? `Couldn't use ${SETUP_SIZE_NAMES[one] ?? SIZE_NAMES[one]}`, "fail");
      return false;
    }
    display = set.state;
    if (moving) return true;
    ctx.sounds.play("confirm");
    drawFrames(display.size);
    drawSizes();
    const again = sizesBox.querySelector<HTMLElement>(`[data-action="size-${one}"]`);
    if (again) ctx.focus.set(again);
    return true;
  };
  drawFrames(shownSize());
  drawSizes();

  const el = h(
    "div",
    { class: "setup-page d3 setup-look" },
    h("div", { class: "setup-top" }, h("div", {}, ...heading("tv look", "Pick a look", ctx.reduced()))),
    h("div", { class: "setup-look-list" }, ...names),
    h("div", { class: "setup-look-right" }, stage, sizesBox),
  );
  return {
    el,
    first: names.find((name) => name.dataset.look === current) ?? names[0],
    // The preview follows the look with the focus, and stays on it while the
    // focus is on a size.
    focused(target) {
      const id = target.dataset.look;
      if (id) show(id);
    },
  };
}
