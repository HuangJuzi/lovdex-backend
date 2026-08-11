/**
 * Single source of truth for the two-layer task status domain.
 *
 * Layer 1 `status` — board column (4 values): todo / in_progress / in_review /
 * done. `backlog` is folded into `todo` (P2 removes it from the enum).
 *
 * Layer 2 `sub_status` — the fine-grained badge shown at a card's bottom-left,
 * a refinement of the column it sits in. Persisted subset (DB CHECK) holds the
 * AI verdicts (done/only_plan/needs_review/blocked) plus `failed`; realtime
 * values (running / waiting_* / pending_acceptance) are derived by the service's
 * decorate() on every read.
 */

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export const SUB_STATUSES = [
  'running', 'failed', 'waiting_answer', 'waiting_plan', 'waiting_approval',
  'pending_acceptance', 'done', 'only_plan', 'needs_review', 'blocked',
] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

/** Persisted subset — the only values allowed in the tasks.sub_status column. */
export const PERSISTED_SUB_STATUSES = ['failed', 'done', 'only_plan', 'needs_review', 'blocked'] as const;
export type PersistedSubStatus = (typeof PERSISTED_SUB_STATUSES)[number];

/** AI post-run verdicts (written by writeSummary → sub_status column). */
export const AI_VERDICTS = ['done', 'only_plan', 'needs_review', 'blocked'] as const;
export type AiVerdict = (typeof AI_VERDICTS)[number];

export function isSubStatus(value: unknown): value is SubStatus {
  return typeof value === 'string' && (SUB_STATUSES as readonly string[]).includes(value);
}

export function isPersistedSubStatus(value: unknown): value is PersistedSubStatus {
  return typeof value === 'string' && (PERSISTED_SUB_STATUSES as readonly string[]).includes(value);
}

export function isAiVerdict(value: unknown): value is AiVerdict {
  return typeof value === 'string' && (AI_VERDICTS as readonly string[]).includes(value);
}
