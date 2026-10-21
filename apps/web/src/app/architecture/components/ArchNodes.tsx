"use client";

import { createContext, memo, useContext } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { ArchPlaced } from "@/lib/archModel";
import s from "../styles.module.css";

export type ArchBadge = { text: string; tone?: "danger" | "warn" | "info" | "muted"; title?: string };
export type ArchNodeData = {
  shape: ArchPlaced;
  title: string;
  sub?: string;
  meta?: string;
  icon?: string;
  badges: ArchBadge[];
  /** VNet box / pill: whether the chevron expands or collapses it */
  toggle?: "expand" | "collapse";
  toggleLabel?: string;
  ariaLabel: string;
  /** Shown only as connection context of the category filter (drawn dashed and faded) */
  context?: boolean;
  /** Box kind class (region, vnet, subnet, lane, group, global) */
  variant?: string;
};

/** Actions reached from inside nodes without putting callbacks into node data. */
export const ArchActions = createContext<{ toggleVnet: (id: string) => void }>({ toggleVnet: () => {} });

/** Invisible, non-interactive handles: React Flow needs them to draw lines to custom nodes. */
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className={s.handle} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={s.handle} />
    </>
  );
}

function Badges({ badges }: { badges: ArchBadge[] }) {
  if (!badges.length) return null;
  return (
    <span className={s.badges}>
      {badges.map((b, i) => (
        <span key={`${b.text}-${i}`} className={`${s.badge} ${b.tone ? s[`badge_${b.tone}`] : ""}`} title={b.title}>{b.text}</span>
      ))}
    </span>
  );
}

/** Decorative Azure service icon (a background image keeps it out of the accessibility tree). */
const Icon = ({ src }: { src?: string }) => (src ? <span className={s.icon} style={{ backgroundImage: `url(${src})` }} aria-hidden="true" /> : null);

/** Region / VNet / subnet / lane boundary — the body lets clicks through; only the header is interactive. */
export const BoxNode = memo(function BoxNode({ data }: NodeProps<ArchNodeData>) {
  const { toggleVnet } = useContext(ArchActions);
  return (
    <div className={`${s.box} ${data.variant ? s[`box_${data.variant}`] : ""}`}>
      <Handles />
      <div className={s.boxHead}>
        <button type="button" className={s.boxTitle} aria-label={data.ariaLabel}>
          <Icon src={data.icon} />
          <span className={s.boxName}>{data.title}</span>
          {data.sub ? <span className={s.boxSub}>{data.sub}</span> : null}
        </button>
        <Badges badges={data.badges} />
        {data.toggle ? (
          <button
            type="button"
            className={s.chevron}
            aria-label={data.toggleLabel}
            aria-expanded={data.toggle === "collapse"}
            onClick={(e) => { e.stopPropagation(); toggleVnet(data.shape.id); }}
          >
            {data.toggle === "collapse" ? "−" : "+"}
          </button>
        ) : null}
      </div>
    </div>
  );
});

/** Resource tile (also used for stacks and their fold tiles, ghosts, the Internet and collapsed VNets). */
export const TileNode = memo(function TileNode({ data }: NodeProps<ArchNodeData>) {
  const kind = data.shape.shape;
  // A stack and the fold tile that replaces it once open are one toggle in one spot (the page's onNodeClick)
  const toggle = kind === "stack" || kind === "fold" ? data.toggle : undefined;
  return (
    <button
      type="button"
      className={`${s.tile} ${s[`tile_${kind}`] ?? ""} ${data.context ? s.context : ""}`}
      aria-label={data.ariaLabel}
      aria-expanded={toggle ? toggle === "collapse" : undefined}
      data-export={kind === "fold" ? "skip" : undefined}
    >
      <Handles />
      <Icon src={data.icon} />
      <span className={s.tileText}>
        <span className={s.tileName}>{data.title}</span>
        {data.sub ? <span className={s.tileSub}>{data.sub}</span> : null}
        {data.meta ? <span className={s.tileMeta}>{data.meta}</span> : null}
      </span>
      <Badges badges={data.badges} />
      {toggle ? <span className={s.tileChevron} aria-hidden="true">{toggle === "collapse" ? "▴" : "▾"}</span> : null}
    </button>
  );
});

export const NODE_TYPES = { archBox: BoxNode, archTile: TileNode } as const;
