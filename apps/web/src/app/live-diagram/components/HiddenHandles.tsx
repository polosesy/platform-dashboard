"use client";

import { Handle, Position } from "reactflow";

const HIDDEN = { opacity: 0, pointerEvents: "none" as const, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

/**
 * Invisible connection points on all four sides. The router (lib/liveRoute.ts) names the handle every line
 * uses (`s-r` → `t-l`, `s-b` → `t-t`, …); React Flow needs them to exist on the node to draw the line.
 */
export function HiddenHandles() {
  return (
    <>
      <Handle id="s-l" type="source" position={Position.Left} style={HIDDEN} />
      <Handle id="s-r" type="source" position={Position.Right} style={HIDDEN} />
      <Handle id="s-t" type="source" position={Position.Top} style={HIDDEN} />
      <Handle id="s-b" type="source" position={Position.Bottom} style={HIDDEN} />
      <Handle id="t-l" type="target" position={Position.Left} style={HIDDEN} />
      <Handle id="t-r" type="target" position={Position.Right} style={HIDDEN} />
      <Handle id="t-t" type="target" position={Position.Top} style={HIDDEN} />
      <Handle id="t-b" type="target" position={Position.Bottom} style={HIDDEN} />
    </>
  );
}
