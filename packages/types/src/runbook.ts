// ─────────────────────────────────────────────────────────────
// 사례·런북 (알림·대응 › 사례·런북) — the team's experience: what happened and how it was fixed (cases), and the
// procedures it repeats (runbooks). Design: docs/architecture/ops-knowledge.md
// ─────────────────────────────────────────────────────────────

/**
 * A fact a case or an error text carries, matched exactly (lower-cased): a Kubernetes event reason (OOMKilled …),
 * a process exit code, a Cilium drop reason, an alert rule, an HTTP status, an error code (AADSTS…, this platform's
 * snake_case codes), an exception class, an Azure resource type, or a keyword the author chose
 */
export type OpsSignalKind = "k8sReason" | "exitCode" | "dropReason" | "alertRule" | "httpStatus" | "errorCode" | "exception" | "resourceType" | "keyword";
export type OpsSignal = { kind: OpsSignalKind; value: string };

/** Where it happened — names only (a cluster's ARM id decides who may see the case) */
export type OpsScope = { clusterId?: string; clusterName?: string; namespace?: string; workload?: string; resourceType?: string };

export type OpsCaseStatus = "open" | "mitigated" | "resolved";

/**
 * One line of an incident's story (incident.io timeline): when it fired, what was seen or changed, what was done.
 * `alert` lines come from the recurrence group / the alert it started from; the rest are written by responders.
 */
export type OpsTimelineKind = "alert" | "change" | "action" | "note" | "status";
export type OpsTimelineEntry = { at: string; kind: OpsTimelineKind; text: string; by?: string };

/** A follow-up so it does not happen again (incident.io follow-ups · PagerDuty postmortem action items) */
export type OpsFollowUp = { id: string; title: string; owner?: string; due?: string; status: "open" | "done"; doneAt?: string };
export type OpsSeverity = "sev1" | "sev2" | "sev3" | "sev4";

export type OpsCase = {
  id: string;
  title: string;
  status: OpsCaseStatus;
  severity: OpsSeverity;
  occurredAt: string;
  resolvedAt?: string;
  /** What was seen (required) */
  symptoms: string;
  cause?: string;
  /** What fixed it — required to mark it resolved */
  resolution?: string;
  lessons?: string;
  tags: string[];
  signals: OpsSignal[];
  scope: OpsScope;
  /** Runbooks used for it */
  runbookIds: string[];
  /** Where it came from: an alert of the notification centre, or written by hand */
  source?: { kind: "alert" | "manual"; ref?: string };
  /** The recurrence group it answers (rule × target — OpsRecurrenceGroup.key): every later firing finds this case */
  recurrenceKey?: string;
  timeline?: OpsTimelineEntry[];
  followUps?: OpsFollowUp[];
  team?: string;
  rev: number;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  /** Secrets masked when it was saved (tokens, keys pasted with an error) */
  redactions?: number;
};

export type OpsRunbookStep = {
  title: string;
  detail?: string;
  /** Copied, never run by the platform */
  command?: string;
  /** How to tell the step worked */
  check?: string;
};

export type OpsRunbook = {
  id: string;
  title: string;
  /** When to use it (the symptom or alert it answers) */
  when: string;
  signals: OpsSignal[];
  tags: string[];
  steps: OpsRunbookStep[];
  rollback?: string;
  team?: string;
  /** Last time someone confirmed the steps still work */
  verifiedAt?: string;
  rev: number;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  redactions?: number;
};

/** Computed from the cases that name a runbook — never stored, so it cannot be inflated */
export type OpsRunbookUsage = { cases: number; resolved: number; lastUsedAt: string | null };

export type OpsKnowledgeResponse = {
  cases: OpsCase[];
  runbooks: OpsRunbook[];
  usage: Record<string, OpsRunbookUsage>;
  /** Kept on disk (else in memory — lost on restart) */
  durable: boolean;
  signedIn: boolean;
  canWrite: boolean;
};

export type OpsSimilarRequest = {
  text?: string;
  signals?: OpsSignal[];
  scope?: OpsScope;
  /** Leave this case out (the case being edited) */
  exclude?: string;
};

/** strong ≥ 0.45 · medium ≥ 0.25 · weak — a level, not a percentage */
export type OpsMatchStrength = "strong" | "medium" | "weak";
export type OpsMatch = {
  id: string;
  score: number;
  strength: OpsMatchStrength;
  why: {
    /** Signals both sides carry */
    signals: OpsSignal[];
    /** The words that weighed most in the text similarity */
    terms: string[];
    /** workload · namespace · resourceType · cluster */
    scope: string[];
  };
};

// ── Agent (stage 2 — skeleton only: docs/architecture/ops-knowledge.md §8) ──

/** Whether an agent may draft, and why not */
export type OpsAgentStatus = {
  state: "notConfigured" | "ready";
  /** "none" until a provider is chosen (Microsoft Foundry · Anthropic API — a decision, §8) */
  provider: "none";
  /** What it would be sent, at most (the context is masked and cut before it leaves) */
  limits: { textChars: number; cases: number; runbooks: number; fieldChars: number };
};

/** What an agent is given: the operator's text and the team's closest experience — masked, cut, nothing else */
export type OpsAgentContext = {
  text: string;
  signals: OpsSignal[];
  cases: Array<{ id: string; title: string; status: OpsCaseStatus; symptoms: string; cause?: string; resolution?: string }>;
  runbooks: Array<{ id: string; title: string; when: string; steps: string[] }>;
  /** Secrets masked while building it */
  redactions: number;
};

/** An agent's draft — never saved by itself; shown as "agent draft — review", with the experience it leaned on */
export type OpsAgentDraft = {
  title: string;
  symptoms: string;
  causeCandidates: Array<{ text: string; basis: string[] }>;
  nextSteps: string[];
  basis: { cases: string[]; runbooks: string[] };
  provider: string;
  generatedAt: string;
};

export type OpsSimilarResponse = {
  /** Signals found in the text (plus the ones sent) */
  extracted: OpsSignal[];
  cases: OpsMatch[];
  runbooks: OpsMatch[];
  /**
   * The experience helper: runbooks the similar cases used and the ones matched directly, most used first — each with
   * the similar cases that used it. Experience, not a verdict: the operator decides.
   */
  suggested: Array<{ runbookId: string; fromCases: string[]; direct: boolean }>;
};

// ── 재발 (recurrence) — the same alert rule on the same target, firing again (docs/architecture/ops-knowledge.md §10) ──

/**
 * One rule × target over the window: every firing of it. Facts only — counts and times as the alert sources gave them;
 * linked = a case written for this group (recurrenceKey) · rule = cases/runbooks that name the alert rule.
 */
export type OpsRecurrenceGroup = {
  /** `<source>:<rule>|<target>` lower-cased — stable across firings (what a case stores as recurrenceKey) */
  key: string;
  source: "azureMonitor" | "alertCenter";
  rule: string;
  /** what it fired on: an Azure resource (name · type · resource group) or a Kubernetes workload (namespace/name) */
  target: { name: string; type?: string; resourceGroup?: string; namespace?: string };
  severity: OpsSeverity;
  /** firings in the window (an alert centre item counts its re-firings) */
  occurrences: number;
  /** still firing now (not resolved) — and since when */
  firingNow: number;
  firingSince?: string;
  firstAt: string;
  lastAt: string;
  /** minutes from firing to resolved, over the firings that resolved — null when none did */
  resolveMinutes: { p50: number; max: number; n: number } | null;
  /** the last firings (newest first, ≤ 10) — the timeline a new case starts from */
  recent: Array<{ at: string; resolvedAt?: string }>;
  cases: { linked: string[]; rule: string[] };
  runbooks: string[];
};

export type OpsRecurrenceResponse = {
  generatedAt: string;
  days: number;
  /** ok = every source answered; partial = some subscription or the alert centre failed (listed in gaps) */
  state: "ok" | "partial" | "failed";
  /**
   * What was not read, or read in part. `code` rgOnly = the identity reads that subscription only through resource-group
   * roles: Azure returns only those groups' alerts (stg 2026-11-17: 3 of 38) · truncated = more pages than read · failed
   */
  gaps: Array<{ source: "azureMonitor" | "alertCenter"; scope: string; reason: string; code?: "rgOnly" | "truncated" | "failed" }>;
  totals: {
    alerts: number;
    groups: number;
    /** groups that fired 2+ times */
    recurring: number;
    firingNow: number;
    /** recurring groups with no case (linked or by rule) — the team has not written down what it learnt */
    recurringNoCase: number;
    recurringNoRunbook: number;
  };
  groups: OpsRecurrenceGroup[];
};
