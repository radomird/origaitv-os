// Fit to screen's screen (ADR-103): four corner marks where the margin puts
// the edge of what apps fill, the picture's size, and a tip for a TV that can
// show the whole picture itself. Left makes the picture smaller and right
// bigger, a step at a time, down to no margin at all, and the TV takes each
// step at once: the marks move, apps are maximized inside the new margin and
// home's words and tiles move with it. Settings, Appearance opens it as a
// page of its own (pages/fit.ts), and setup shows it right after the size
// (setup/fit.ts), in Terminal's style.
//
// A TV that crops the picture's edges (overscan) would cut the marks off,
// so a person makes the picture smaller until all four show.

import { h } from "./dom.ts";
import { margins, pictureSize, steppedMargin, type DisplayState } from "./size.ts";

export const FIT_HEADLINE = "Can you see all four corners?";
// The TV's own word, as its picture menu has it.
export const FIT_TIP = "Turning off overscan in your TV's picture menu shows the whole picture";

export interface FitParts {
  // The four marks, over the whole screen.
  marks: HTMLElement;
  // The picture's size, which left and right change.
  size: HTMLElement;
  // One step: -1 smaller, 1 bigger. False at either end.
  step(by: number): boolean;
  // The margin shown now.
  margin(): number;
}

export interface FitOptions {
  margin: number;
  // The page's canvas, which the marks are placed on.
  canvas: { width: number; height: number };
  // Keeps a margin: the TV takes it at once.
  save(margin: number): Promise<{ state?: DisplayState; error?: string }>;
  failed(error: string): void;
  // The marks moved, for the page's focus ring.
  moved?(): void;
}

// The steps being saved, kept outside any one drawing of the screen. Each
// step the TV takes makes it tell the pages the display changed, and the
// page in front is drawn again, with a new fitParts. That one is handed the
// margin the TV had kept last, which is behind the one on screen while steps
// are still on their way. So while one is out, a new drawing starts from
// what was shown, and the steps go on being saved in order, one at a time.
interface Steps {
  shown: number;
  saved: number;
  saving: boolean;
  wanted: number | null;
  // The drawing in front now, which hears how a save went.
  drawn: { draw(): void; save: FitOptions["save"]; failed: FitOptions["failed"] };
}
let steps: Steps | null = null;

// Whether steps are still on their way to the TV.
const busy = (at: Steps | null): at is Steps => at !== null && (at.saving || at.wanted !== null);

export function fitParts(o: FitOptions): FitParts {
  const at: Steps = busy(steps) ? steps : { shown: o.margin, saved: o.margin, saving: false, wanted: null, drawn: { draw: () => {}, save: o.save, failed: o.failed } };
  steps = at;

  const marks = h(
    "div",
    { class: "fit-marks", "aria-hidden": "true" },
    ...["top-left", "top-right", "bottom-left", "bottom-right"].map((corner) => h("div", { class: `fit-mark ${corner}` })),
  );
  const value = h("span", { class: "button-value fit-value" });
  const size = h("button", { class: "button fit-size", "data-focus": true, "data-action": "fit-size", "data-adjust": "fit" }, h("span", {}, "Picture size"), value);

  const draw = () => {
    const shown = at.shown;
    const where = margins(shown, o.canvas);
    marks.style.setProperty("--mark-x", `${where.x}px`);
    marks.style.setProperty("--mark-y", `${where.y}px`);
    marks.classList.toggle("none", shown === 0);
    value.textContent = shown === 0 ? "Whole screen" : `${pictureSize(shown)}%`;
    size.classList.toggle("smallest", steppedMargin(shown, -1) === null);
    size.classList.toggle("biggest", steppedMargin(shown, 1) === null);
    o.moved?.();
  };
  at.drawn = { draw, save: o.save, failed: o.failed };

  draw();
  return {
    marks,
    size,
    margin: () => at.shown,
    step(by) {
      const next = steppedMargin(at.shown, by);
      if (next === null) return false;
      at.shown = next;
      at.wanted = next;
      draw();
      void send(at);
      return true;
    },
  };
}

// Saves the last step taken, once the one before it is saved. A step that
// fails puts the screen back to what the TV kept.
async function send(at: Steps): Promise<void> {
  if (at.saving || at.wanted === null) return;
  at.saving = true;
  const margin = at.wanted;
  at.wanted = null;
  const answer = await at.drawn.save(margin);
  at.saving = false;
  if (answer.state) at.saved = answer.state.margin;
  else {
    at.wanted = null;
    at.shown = at.saved;
    at.drawn.draw();
    at.drawn.failed(answer.error ?? "Couldn't change the picture size");
    return;
  }
  void send(at);
}
