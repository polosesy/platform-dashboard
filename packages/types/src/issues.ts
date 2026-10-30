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

export type IssueStatesResponse = {
  states: Record<string, IssueState>;
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
