// Viewport safety for the infrastructure diagram canvas — pure (no React, no DOM; tested in apps/api/test/archView.test.ts).
//
// A screen-capture tool (Win+Shift+S …) or Alt+Tab takes the mouse in the middle of a pan or a card drag: the page never
// gets the mouseup, and d3-zoom / d3-drag (listening on window, never looking at the buttons) treat every later plain
// move as part of the gesture — the diagram slid off the canvas and looked gone. `gestureStep` decides when a gesture
// must be ended; `viewportLost` tells the canvas the diagram is off screen (or the viewport is not a number).

export type GestureState = { active: boolean; x: number; y: number };
export type GestureEvent =
  | { type: "down"; button: number; x: number; y: number }
  | { type: "move"; buttons: number; x: number; y: number }
  | { type: "up" }
  | { type: "blur" };

/** One input event → the next state, and whether the running gesture must be ended now (abort) */
export function gestureStep(st: GestureState, ev: GestureEvent): { state: GestureState; abort: boolean } {
  switch (ev.type) {
    case "down":
      return { state: ev.button === 0 ? { active: true, x: ev.x, y: ev.y } : st, abort: false };
    case "move":
      // The primary button is no longer held, but no mouseup came: the gesture was taken away mid-way
      if (st.active && (ev.buttons & 1) === 0) return { state: { active: false, x: ev.x, y: ev.y }, abort: true };
      return { state: { ...st, x: ev.x, y: ev.y }, abort: false };
    case "up":
      return { state: { ...st, active: false }, abort: false };
    case "blur":
      return { state: { ...st, active: false }, abort: st.active };
  }
}

type Rect = { width: number; height: number };

/**
 * Is the diagram (layout bounds at 0,0) off the pane? "invalid" = the viewport is not a finite number (repair at once);
 * "off" = under 2% of the pane shows any of it; false = fine. A pane not measured yet is never "lost".
 */
export function viewportLost(bounds: Rect, transform: readonly [number, number, number], pane: Rect): false | "invalid" | "off" {
  const [tx, ty, k] = transform;
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(k) || k <= 0) return "invalid";
  if (pane.width <= 0 || pane.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return false;
  const x0 = Math.max(0, tx), y0 = Math.max(0, ty);
  const x1 = Math.min(pane.width, tx + bounds.width * k), y1 = Math.min(pane.height, ty + bounds.height * k);
  const seen = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const need = Math.min(pane.width * pane.height, bounds.width * k * bounds.height * k) * 0.02;
  return seen < need ? "off" : false;
}
