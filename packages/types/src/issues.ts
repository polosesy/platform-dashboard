// 통합 위험 › 이슈 목록 — one queue over the sources that each find risk on their own (cluster risk combinations,
// workload identity, Defender alerts, urgent vulnerabilities), with a team-shared status per issue.

/** open → inProgress → resolved, or accepted (an exception with a reason and an expiry) */
export type IssueStatus = "open" | "inProgress" | "resolved" | "accepted";

export type IssueStateChange = { status: IssueStatus; at: string; by?: string; note?: string; until?: string };

/** What the team said about one issue (stored per subscription; the issue itself is recomputed from its source) */
export type IssueState = {
  status: IssueStatus;
  note?: string;
  /** Free text — a person or a team (no directory lookup) */
  assignee?: string;
  /** accepted only: the exception ends at this date (ISO), then the issue is open again */
  until?: string;
  /** Per-issue revision — a write names the revision it saw; a stale write gets 409 */
  rev: number;
  updatedAt: string;
  /** Display name from the token (never an object id) */
  updatedBy?: string;
  /** Newest first, at most 20 */
  history: IssueStateChange[];
};

/**
 * Who owns what (connection file `owners`): the first rule that matches wins — namespace rules before resource-group
 * rules. Patterns are exact names (case-insensitive) or a prefix ending in `*`. Team names only.
 */
export type OwnerRule = { team: string; namespaces?: string[]; resourceGroups?: string[] };

export type IssueStatesResponse = {
  states: Record<string, IssueState>;
  /** The subscription's connection `owners` (empty = no mapping) */
  owners?: OwnerRule[];
  /** false = kept in memory only (no state directory) — lost on restart */
  durable: boolean;
  signedIn: boolean;
  /** Operator or above may change a status */
  canWrite: boolean;
};

export type IssueStateUpdate = {
  status: IssueStatus;
  note?: string;
  assignee?: string;
  until?: string;
  /** The `rev` the caller saw (null = the issue had no state yet) */
  baseRev: number | null;
};

// ── 그래프 탐색 › 팀 저장 질문 (보안 고도화 P5) ──

/** A question of the graph explorer kept for the team. `watch` = every match becomes an issue in the issue list. */
export type SavedQuery = {
  /** Lowercase slug, unique per subscription */
  id: string;
  name: string;
  /** Condition keys joined by "." (the explorer's URL form) */
  q: string;
  includeManaged: boolean;
  watch: boolean;
  /** Severity of the issues a watched question raises */
  sev: "critical" | "high" | "medium";
  rev: number;
  updatedAt: string;
  /** Display name from the token (never an object id) */
  updatedBy?: string;
};

export type SavedQueriesResponse = {
  queries: SavedQuery[];
  durable: boolean;
  signedIn: boolean;
  /** Operator or above may save, change or delete */
  canWrite: boolean;
};

export type SavedQueryUpdate = {
  name: string;
  q: string;
  includeManaged: boolean;
  watch: boolean;
  sev: SavedQuery["sev"];
  /** The `rev` the caller saw (null = new) */
  baseRev: number | null;
};
