"use client";

import { useRef, useState, type RefObject } from "react";
import type { Node } from "reactflow";
import type { ArchLayout, ArchPlaced } from "@/lib/archModel";
import { archExportFileName, toDrawio } from "@/lib/archDrawio";
import { downloadBlob } from "@/lib/download";
import { maskGuids } from "@/lib/mask";
import type { ArchNodeData } from "../components/ArchNodes";

type Params = {
  layout: ArchLayout;
  nodes: Node<ArchNodeData>[];
  /** Localized caption lines (view settings, caveats) */
  caption: string[];
  title: string;
  region: string;
  filtered: boolean;
  sample: boolean;
  context: ReadonlySet<string>;
  dimmed: ReadonlySet<string>;
  /** The element that wraps the React Flow canvas */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** Localized error texts */
  messages: { tooLarge: string; failed: string };
};

const PAD = 24;
const CAPTION_LINE = 18;
const MAX_NODES = 1500;
const MAX_PIXELS = 16_000_000; // Safari canvas area limit is ~16.7 MP
const MAX_SIDE = 16_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** draw.io and PNG export of the current diagram view. */
export function useDiagramExport(p: Params) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const labelMap = () => {
    const m = new Map<string, string>();
    for (const n of p.nodes) m.set(n.id, [n.data.title, n.data.sub, n.data.meta].filter(Boolean).join("\n"));
    return (sh: ArchPlaced) => m.get(sh.id) ?? "";
  };

  const exportDrawio = () => {
    setError(null);
    try {
      const xml = toDrawio(p.layout, { label: labelMap(), title: p.title, caption: p.caption, context: p.context, dimmed: p.dimmed });
      const name = archExportFileName({ region: p.region, filtered: p.filtered, sample: p.sample, now: new Date(), ext: "drawio" });
      downloadBlob(new Blob([xml], { type: "application/vnd.jgraph.mxfile" }), name);
    } catch (e: unknown) {
      setError(`${p.messages.failed} ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const exportPng = async () => {
    if (busy.current) return; // double clicks never start a second capture
    busy.current = true;
    setError(null);
    setExporting(true);
    let inner: HTMLCanvasElement | null = null;
    try {
      const W = p.layout.width + 2 * PAD;
      const H = p.layout.height + 2 * PAD;
      const CAP = CAPTION_LINE * p.caption.length + 16;
      if (p.layout.shapes.length > MAX_NODES) throw new Error(p.messages.tooLarge);
      const ratio = Math.min(2, Math.sqrt(MAX_PIXELS / (W * (H + CAP))), MAX_SIDE / Math.max(W, H + CAP));
      if (ratio < 0.5) throw new Error(p.messages.tooLarge);

      const { toCanvas } = await import("html-to-image");
      await document.fonts.ready;
      // Off-screen nodes mount once virtualization is off; wait until every node and line is measured
      const root = p.canvasRef.current;
      const expectEdges = p.layout.edges.length;
      for (let i = 0; i < 50; i++) {
        await nextFrame();
        const nodes = root?.querySelectorAll(".react-flow__node") ?? [];
        const ready =
          nodes.length >= p.layout.shapes.length &&
          [...nodes].every((n) => (n as HTMLElement).style.visibility !== "hidden") &&
          (root?.querySelectorAll(".react-flow__edge-path").length ?? 0) >= expectEdges;
        if (ready) break;
        await sleep(100);
      }
      const viewport = root?.querySelector<HTMLElement>(".react-flow__viewport");
      if (!viewport) throw new Error("no canvas");

      inner = await toCanvas(viewport, {
        width: W,
        height: H,
        pixelRatio: ratio,
        style: { transform: `translate(${PAD}px, ${PAD}px) scale(1)`, width: `${W}px`, height: `${H}px` },
        // Screen controls (a stack's fold tile) are not part of the picture — same as the draw.io export
        filter: (el) => !(el instanceof HTMLElement && el.dataset.export === "skip"),
      });

      const out = document.createElement("canvas");
      out.width = Math.round(W * ratio);
      out.height = Math.round((H + CAP) * ratio);
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.scale(ratio, ratio);
      // Page background with the canvas panel tint over it — what the user sees behind the diagram
      const cs = getComputedStyle(document.body);
      ctx.fillStyle = cs.backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, W, H + CAP);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() || "rgba(255,255,255,0.72)";
      ctx.fillRect(0, 0, W, H + CAP);
      ctx.drawImage(inner, 0, 0, W, H);
      inner.width = 0; // release the intermediate bitmap right away
      inner.height = 0;
      inner = null;

      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#555";
      ctx.font = `12px ${cs.fontFamily}`;
      p.caption.forEach((line, i) => {
        let text = maskGuids(line);
        while (text.length > 4 && ctx.measureText(text).width > W - 2 * PAD) text = `${text.slice(0, -2)}…`;
        ctx.fillText(text, PAD, H + 4 + CAPTION_LINE * (i + 1));
      });

      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      out.width = 0;
      out.height = 0;
      if (!blob) throw new Error(p.messages.tooLarge);
      downloadBlob(blob, archExportFileName({ region: p.region, filtered: p.filtered, sample: p.sample, now: new Date(), ext: "png" }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg === p.messages.tooLarge ? msg : `${p.messages.failed} ${msg}`);
    } finally {
      if (inner) { inner.width = 0; inner.height = 0; }
      busy.current = false;
      setExporting(false);
    }
  };

  return { exporting, error, exportDrawio, exportPng };
}
