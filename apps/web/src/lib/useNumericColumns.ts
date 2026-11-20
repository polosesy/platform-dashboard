"use client";

import { useEffect, type RefObject } from "react";
import { numericColumns, type CellText } from "./numericColumns";

/** Rows read to decide a column (a long table is decided by its first rows; every row is then marked) */
const SAMPLE_ROWS = 200;

/** Marks the cells (td · th, head and body) of every number column with data-num — globals.css aligns them right */
export function markNumericColumns(root: ParentNode): void {
  for (const table of root.querySelectorAll<HTMLTableElement>("table")) {
    if (table.closest("[data-align='left']")) continue;
    const body = [...table.tBodies].flatMap((b) => [...b.rows]);
    const sample: CellText[][] = body.slice(0, SAMPLE_ROWS).map((r) => [...r.cells].map((c) => ({ text: c.textContent ?? "", span: c.colSpan || 1 })));
    const num = new Set(numericColumns(sample));
    const rows = [...(table.tHead ? [...table.tHead.rows] : []), ...body, ...(table.tFoot ? [...table.tFoot.rows] : [])];
    for (const r of rows) {
      let col = 0;
      for (const c of r.cells) {
        const on = (c.colSpan || 1) === 1 && num.has(col);
        if (on !== c.hasAttribute("data-num")) {
          if (on) c.setAttribute("data-num", ""); else c.removeAttribute("data-num");
        }
        col += c.colSpan || 1;
      }
    }
  }
}

/**
 * Keeps the marks current under `root` (the app content): tables appear, load, filter and poll — one pass per animation
 * frame after any change, and only attributes that differ are written (writing them does not re-trigger the pass:
 * attribute changes are not observed).
 */
export function useNumericColumns(root: RefObject<HTMLElement | null>, key: string): void {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const run = () => { frame = 0; markNumericColumns(el); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
    schedule();
    const obs = new MutationObserver(schedule);
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { obs.disconnect(); if (frame) cancelAnimationFrame(frame); };
    // `key` (the path): the frame mounts its content area only on framed routes — re-attach when the screen changes
  }, [root, key]);
}
