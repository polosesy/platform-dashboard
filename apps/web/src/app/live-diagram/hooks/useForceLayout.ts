"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { DiagramNodeSpec, DiagramEdgeSpec } from "@aud/types";

type ForceNode = SimulationNodeDatum & {
  id: string;
  fx?: number | null;
  fy?: number | null;
};

type ForceLink = SimulationLinkDatum<ForceNode> & {
  id: string;
};

type NodePosition = { x: number; y: number };

type UseForceLayoutOptions = {
  enabled: boolean;
  width: number;
  height: number;
  strength?: number;
  distance?: number;
};

export function useForceLayout(
  nodes: DiagramNodeSpec[],
  edges: DiagramEdgeSpec[],
  options: UseForceLayoutOptions,
) {
  const { enabled, width, height, strength = -300, distance = 180 } = options;
  const [positions, setPositions] = useState<Map<string, NodePosition>>(new Map());
  const simRef = useRef<ReturnType<typeof forceSimulation<ForceNode>> | null>(null);
  const throttleRef = useRef(0);

  const stop = useCallback(() => {
    simRef.current?.stop();
    simRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || nodes.length === 0) {
      stop();
      return;
    }

    const forceNodes: ForceNode[] = nodes.map((n) => ({
      id: n.id,
      x: n.position?.x ?? width / 2 + (Math.random() - 0.5) * 200,
      y: n.position?.y ?? height / 2 + (Math.random() - 0.5) * 200,
    }));

    const nodeMap = new Map(forceNodes.map((n) => [n.id, n]));

    const forceLinks: ForceLink[] = edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      }));

    const sim = forceSimulation<ForceNode>(forceNodes)
      .force(
        "link",
        forceLink<ForceNode, ForceLink>(forceLinks)
          .id((d) => d.id)
          .distance(distance),
      )
      .force("charge", forceManyBody<ForceNode>().strength(strength))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide<ForceNode>(80))
      .alphaDecay(0.02)
      .velocityDecay(0.3);

    sim.on("tick", () => {
      // Throttle React updates to ~30fps
      const now = performance.now();
      if (now - throttleRef.current < 33) return;
      throttleRef.current = now;

      const next = new Map<string, NodePosition>();
      for (const node of forceNodes) {
        next.set(node.id, {
          x: node.x ?? 0,
          y: node.y ?? 0,
        });
      }
      setPositions(next);
    });

    simRef.current = sim;

    return () => {
      sim.stop();
    };
  }, [enabled, nodes, edges, width, height, strength, distance, stop]);

  const pinNode = useCallback(
    (nodeId: string, x: number, y: number) => {
      const sim = simRef.current;
      if (!sim) return;
      const node = sim.nodes().find((n) => n.id === nodeId);
      if (node) {
        node.fx = x;
        node.fy = y;
        sim.alpha(0.3).restart();
      }
    },
    [],
  );

  const unpinNode = useCallback(
    (nodeId: string) => {
      const sim = simRef.current;
      if (!sim) return;
      const node = sim.nodes().find((n) => n.id === nodeId);
      if (node) {
        node.fx = null;
        node.fy = null;
        sim.alpha(0.3).restart();
      }
    },
    [],
  );

  return { positions, pinNode, unpinNode, stop };
}
