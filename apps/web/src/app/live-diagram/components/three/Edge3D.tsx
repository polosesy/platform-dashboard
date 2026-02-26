"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { EdgeStatus, EdgeTrafficLevel } from "@aud/types";

type Edge3DProps = {
  sourcePos: [number, number, number];
  targetPos: [number, number, number];
  status: EdgeStatus;
  trafficLevel: EdgeTrafficLevel;
  throughputBps?: number;
};

const STATUS_COLORS: Record<EdgeStatus, string> = {
  normal: "#0078d4",
  degraded: "#d18400",
  down: "#d83b01",
  idle: "#8a8886",
};

const TRAFFIC_PARTICLE_COUNT: Record<EdgeTrafficLevel, number> = {
  none: 0,
  low: 3,
  medium: 6,
  high: 10,
  burst: 16,
};

const TRAFFIC_SPEED: Record<EdgeTrafficLevel, number> = {
  none: 0,
  low: 0.15,
  medium: 0.3,
  high: 0.5,
  burst: 0.8,
};

export function Edge3D({
  sourcePos,
  targetPos,
  status,
  trafficLevel,
}: Edge3DProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const particleOffsetsRef = useRef<Float32Array | null>(null);
  const color = STATUS_COLORS[status];
  const particleCount = TRAFFIC_PARTICLE_COUNT[trafficLevel];
  const speed = TRAFFIC_SPEED[trafficLevel];

  // Build curve between source and target
  const curve = useMemo(() => {
    const src = new THREE.Vector3(...sourcePos);
    const tgt = new THREE.Vector3(...targetPos);
    const mid = new THREE.Vector3().lerpVectors(src, tgt, 0.5);
    mid.z += 0.8; // Arc upward
    return new THREE.QuadraticBezierCurve3(src, mid, tgt);
  }, [sourcePos, targetPos]);

  // Tube geometry for the edge line
  const tubeGeo = useMemo(() => {
    const radius = status === "down" ? 0.04 : 0.025;
    return new THREE.TubeGeometry(curve, 32, radius, 8, false);
  }, [curve, status]);

  // Particle positions buffer
  const particleGeo = useMemo(() => {
    if (particleCount === 0) return null;

    const offsets = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      offsets[i] = i / particleCount;
    }
    particleOffsetsRef.current = offsets;

    const positions = new Float32Array(particleCount * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [particleCount]);

  // Animate particles along curve
  useFrame((_, delta) => {
    if (!pointsRef.current || !particleOffsetsRef.current || !particleGeo) return;

    const offsets = particleOffsetsRef.current;
    const posAttr = particleGeo.getAttribute("position");
    if (!posAttr) return;

    for (let i = 0; i < offsets.length; i++) {
      offsets[i] = (offsets[i]! + speed * delta) % 1;
      const point = curve.getPoint(offsets[i]!);
      posAttr.setXYZ(i, point.x, point.y, point.z);
    }
    posAttr.needsUpdate = true;
  });

  // Dash pattern for down/idle status
  const dashProps = useMemo(() => {
    if (status === "down") return { dashSize: 0.15, gapSize: 0.1 };
    if (status === "idle") return { dashSize: 0.08, gapSize: 0.15 };
    return null;
  }, [status]);

  return (
    <group>
      {/* Glow layer for degraded/down */}
      {(status === "degraded" || status === "down") && (
        <mesh geometry={tubeGeo}>
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.15}
          />
        </mesh>
      )}

      {/* Main tube */}
      <mesh geometry={tubeGeo}>
        {dashProps ? (
          <meshBasicMaterial
            color={color}
            transparent
            opacity={status === "idle" ? 0.4 : 0.7}
          />
        ) : (
          <meshStandardMaterial
            color={color}
            transparent
            opacity={0.65}
            emissive={color}
            emissiveIntensity={0.2}
          />
        )}
      </mesh>

      {/* Animated particles */}
      {particleGeo && particleCount > 0 && (
        <points ref={pointsRef} geometry={particleGeo}>
          <pointsMaterial
            size={status === "down" ? 0.12 : 0.08}
            color={status === "down" ? "#d83b01" : color}
            transparent
            opacity={0.85}
            sizeAttenuation
          />
        </points>
      )}
    </group>
  );
}
