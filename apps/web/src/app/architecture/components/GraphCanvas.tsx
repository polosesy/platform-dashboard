"use client";

import ReactFlow, {
  Background,
  Controls,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeChange,
  type EdgeChange,
} from "reactflow";
import type { ArchitectureNode } from "@aud/types";
import { healthTone } from "../utils/graphUtils";
import styles from "../styles.module.css";

type GraphCanvasProps = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onNodeClick: (node: ArchitectureNode | null) => void;
};

export function GraphCanvas({ nodes, edges, onNodesChange, onEdgesChange, onNodeClick }: GraphCanvasProps) {
  const renderedNodes = nodes.map((n) => {
    const node = (n.data as { node: ArchitectureNode }).node;
    const tone = healthTone(node.health);
    return {
      ...n,
      data: {
        label: (
          <div className={`${styles.node} ${styles[`node_${tone}`]}`}>
            <div className={styles.nodeName}>{node.name}</div>
            <div className={styles.nodeKind}>{node.kind}</div>
          </div>
        ),
        node,
      },
    };
  });

  return (
    <div className={styles.flowWrap}>
      <ReactFlow
        nodes={renderedNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_e, n) =>
          onNodeClick(((n.data as { node?: ArchitectureNode })?.node ?? null) as ArchitectureNode | null)
        }
        fitView
      >
        <Background gap={18} size={1} color="rgba(20,21,23,0.08)" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
