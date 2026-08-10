/**
 * Operator agent configuration.
 *
 * Single source of truth for operator automation settings. Persisted as a
 * JSON blob under the `operator_config` key in `app_config`. Reads merge the
 * stored partial over defaults so new fields pick up their default value
 * automatically without a migration.
 *
 * "Safe defaults" philosophy: out-of-box works with conservative automation —
 * auto-verdict on, auto-move on for only_plan→todo, but `done` stays
 * in_review (human gates completion). `auto_move_done: false` is the key
 * safe default.
 */

import os from 'node:os';

import { appConfigDb } from '@/modules/database/repositories/app-config.js';

export type OperatorConfig = {
  enabled: boolean;
  auto_verdict_enabled: boolean;
  auto_move_enabled: boolean;
  auto_move_done: boolean;
  auto_move_only_plan_to_todo: boolean;
  model: string;
  workspace: string;
  max_concurrent: number;
  verdict_prompt_override: string | null;
  interactive_chat_enabled: boolean;
};

export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  enabled: true,
  auto_verdict_enabled: true,
  auto_move_enabled: true,
  auto_move_done: false,
  auto_move_only_plan_to_todo: true,
  model: process.env.LOVDEX_OPERATOR_MODEL ?? '',
  workspace:
    process.env.LOVDEX_OPERATOR_WORKSPACE ?? `${os.homedir()}/.lovdex/operator-workspace`,
  max_concurrent: parseInt(process.env.LOVDEX_OPERATOR_MAX_CONCURRENT ?? '2', 10),
  verdict_prompt_override: null,
  interactive_chat_enabled: true,
};

const KEY = 'operator_config';

/** Returns the current operator config, merged over safe defaults. */
export function getOperatorConfig(): OperatorConfig {
  const raw = appConfigDb.get(KEY);
  if (!raw) return DEFAULT_OPERATOR_CONFIG;
  try {
    return { ...DEFAULT_OPERATOR_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_OPERATOR_CONFIG;
  }
}

/** Persists a partial update, merged with the current config. */
export function setOperatorConfig(partial: Partial<OperatorConfig>): void {
  const merged = { ...getOperatorConfig(), ...partial };
  appConfigDb.set(KEY, JSON.stringify(merged));
}
