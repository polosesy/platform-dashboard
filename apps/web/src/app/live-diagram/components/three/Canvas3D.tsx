"use client";

import { useMemo, useState, Suspense, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Grid, PerspectiveCamera } from "@react-three/drei";
import type { DiagramSpec, LiveDiagramSnapshot, HealthStatus } from "@aud/types";
import type { EdgeStatus, EdgeTrafficLevel } from "@aud/types";
import { Node3D } from "./Node3D";
import { Edge3D } from "./Edge3D";
import styles from "../../styles.module.css";

type Canvas3DProps = {
  spec: DiagramSpec;
  snapshot: LiveDiagramSnapshot | null;
  onNodeSelect: (nodeId: string | null) => void;
};

// Convert 2D pixel positions to 3D world coordinates
function to3D(pos: { x: number; y: number } | undefined, groupZ: number): [number, number, number] {
  const x = ((pos?.x ?? 0) - 400) / 100;
  const y = ((pos?.y ?? 0) - 300) / -100; // Flip Y
  return [x, y, groupZ];
}

export function Canvas3D({ spec, snapshot, onNodeSelect }: Canvas3DProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleNodeClick = useCallback(
    (id: string) => {
      setSelectedId((prev) => (prev === id ? null : id));
      onNodeSelect(id);
    },
    [onNodeSelect],
  );

  // Group nodes by groupId for Z-axis layering
  const groupDepths = useMemo(() => {
    const groups = new Map<string, number>();
    let depth = 0;
    for (const group of spec.groups) {
      groups.set(group.id, depth);
      depth -= 2; // Each group 2 units deeper
    }
    return groups;
  }, [spec.groups]);

  // Build 3D node data
  const nodes3D = useMemo(() => {
    return spec.nodes.map((nodeSpec) => {
      const live = snapshot?.nodes.find((n) => n.id === nodeSpec.id);
      const groupZ = groupDepths.get(nodeSpec.groupId ?? "") ?? 0;
      return {
        id: nodeSpec.id,
        label: nodeSpec.label,
        icon: nodeSpec.icon,
        health: (live?.health ?? "unknown") as HealthStatus,
        healthScore: live?.healthScore ?? 0.5,
        hasAlert: (live?.activeAlertIds.length ?? 0) > 0,
        position: to3D(nodeSpec.position, groupZ),
      };
    });
  }, [spec.nodes, snapshot?.nodes, groupDepths]);

  // Build 3D edge data
  const edges3D = useMemo(() => {
    const nodeMap = new Map(
      nodes3D.map((n) => [n.id, n.position]),
    );

    return spec.edges.map((edgeSpec) => {
      const live = snapshot?.edges.find((e) => e.id === edgeSpec.id);
      const srcPos = nodeMap.get(edgeSpec.source) ?? [0, 0, 0] as [number, number, number];
      const tgtPos = nodeMap.get(edgeSpec.target) ?? [0, 0, 0] as [number, number, number];
      return {
        id: edgeSpec.id,
        sourcePos: srcPos,
        targetPos: tgtPos,
        status: (live?.status ?? "idle") as EdgeStatus,
        trafficLevel: (live?.trafficLevel ?? "none") as EdgeTrafficLevel,
        throughputBps: live?.metrics.throughputBps,
      };
    });
  }, [spec.edges, snapshot?.edges, nodes3D]);

  return (
    <div className={styles.canvas3dWrap}>
      <Canvas shadows>
        <PerspectiveCamera makeDefault position={[0, 4, 12]} fov={50} />
        <OrbitControls
          enableDamping
          dampingFactor={0.08}
          minDistance={4}
          maxDistance={30}
          maxPolarAngle={Math.PI * 0.85}
        />

        {/* Lighting */}
        <ambientLight intensity={0.5} />
        <directionalLight position={[8, 10, 5]} intensity={0.8} castShadow />
        <directionalLight position={[-5, 6, -3]} intensity={0.3} />

        {/* Environment for reflections */}
        <Suspense fallback={null}>
          <Environment preset="city" />
        </Suspense>

        {/* Ground grid */}
        <Grid
          args={[40, 40]}
          cellSize={1}
          cellThickness={0.5}
          cellColor="rgba(20,21,23,0.08)"
          sectionSize={4}
          sectionThickness={1}
          sectionColor="rgba(20,21,23,0.12)"
          position={[0, -2, 0]}
          fadeDistance={25}
        />

        {/* Edges */}
        {edges3D.map((edge) => (
          <Edge3D
            key={edge.id}
            sourcePos={edge.sourcePos}
            targetPos={edge.targetPos}
            status={edge.status}
            trafficLevel={edge.trafficLevel}
            throughputBps={edge.throughputBps}
          />
        ))}

        {/* Nodes */}
        {nodes3D.map((node) => (
          <Node3D
            key={node.id}
            id={node.id}
            label={node.label}
            icon={node.icon}
            health={node.health}
            healthScore={node.healthScore}
            hasAlert={node.hasAlert}
            position={node.position}
            onClick={handleNodeClick}
          />
        ))}
      </Canvas>

      {/* Selection indicator */}
      {selectedId && (
        <div className={styles.canvas3dSelected}>
          Selected: {selectedId}
        </div>
      )}
    </div>
  );
}
