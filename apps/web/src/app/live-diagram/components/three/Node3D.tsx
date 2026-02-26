"use client";

import { useRef, useState, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, RoundedBox } from "@react-three/drei";
import type { Mesh, MeshStandardMaterial } from "three";
import type { HealthStatus } from "@aud/types";

type Node3DProps = {
  id: string;
  label: string;
  icon: string;
  health: HealthStatus;
  healthScore: number;
  hasAlert: boolean;
  position: [number, number, number];
  onClick: (id: string) => void;
};

const HEALTH_COLORS: Record<HealthStatus, string> = {
  ok: "#10893e",
  warning: "#d18400",
  critical: "#d83b01",
  unknown: "#8a8886",
};

const HEALTH_EMISSIVE: Record<HealthStatus, string> = {
  ok: "#0a5c2a",
  warning: "#8a5700",
  critical: "#8a2500",
  unknown: "#444444",
};

export function Node3D({
  id,
  label,
  icon,
  health,
  healthScore,
  hasAlert,
  position,
  onClick,
}: Node3DProps) {
  const meshRef = useRef<Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const baseColor = HEALTH_COLORS[health];
  const emissiveColor = HEALTH_EMISSIVE[health];

  // Pulsing alert animation
  const alertIntensity = useRef(0);

  useFrame((_, delta) => {
    if (!meshRef.current) return;

    // Hover scale animation
    const targetScale = hovered ? 1.12 : 1;
    const s = meshRef.current.scale.x;
    const newScale = s + (targetScale - s) * Math.min(1, delta * 8);
    meshRef.current.scale.set(newScale, newScale, newScale);

    // Alert pulse
    if (hasAlert) {
      alertIntensity.current += delta * 4;
      const pulse = Math.sin(alertIntensity.current) * 0.5 + 0.5;
      const mat = meshRef.current.material as MeshStandardMaterial;
      if (mat.emissiveIntensity !== undefined) {
        mat.emissiveIntensity = 0.3 + pulse * 0.7;
      }
    }
  });

  // Health ring as a torus
  const ringProgress = useMemo(() => Math.PI * 2 * healthScore, [healthScore]);

  return (
    <group position={position}>
      {/* Node body */}
      <RoundedBox
        ref={meshRef}
        args={[2.4, 1.2, 0.4]}
        radius={0.15}
        smoothness={4}
        onClick={() => onClick(id)}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <meshStandardMaterial
          color={baseColor}
          emissive={emissiveColor}
          emissiveIntensity={hasAlert ? 0.5 : 0.15}
          roughness={0.4}
          metalness={0.1}
          transparent
          opacity={0.92}
        />
      </RoundedBox>

      {/* Health ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.25]}>
        <torusGeometry args={[0.85, 0.06, 8, 64, ringProgress]} />
        <meshStandardMaterial
          color={baseColor}
          emissive={baseColor}
          emissiveIntensity={0.4}
          transparent
          opacity={0.8}
        />
      </mesh>

      {/* Label */}
      <Html
        center
        distanceFactor={8}
        position={[0, -0.9, 0.3]}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            background: "rgba(255,255,255,0.92)",
            padding: "2px 8px",
            borderRadius: "6px",
            fontSize: "11px",
            fontWeight: 800,
            whiteSpace: "nowrap",
            border: `1px solid ${baseColor}`,
            color: "rgba(20,21,23,0.85)",
          }}
        >
          {icon} {label}
        </div>
      </Html>
    </group>
  );
}
