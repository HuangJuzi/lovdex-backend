import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const OPENCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'opencode/deepseek-v4-flash-free', label: 'opencode/deepseek-v4-flash-free' }],
  DEFAULT: 'opencode/deepseek-v4-flash-free',
};

export function runOpenCodeModels(): string[] {
  try {
    const result = spawnSync('opencode', ['models'], { encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0 || !result.stdout) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('/'));
  } catch {
    return [];
  }
}

export function buildOpenCodeModelsDefinition(): ProviderModelsDefinition {
  const lines = runOpenCodeModels();
  if (lines.length === 0) {
    return OPENCODE_FALLBACK_MODELS;
  }
  const seenValues = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const value of lines) {
    if (seenValues.has(value)) {
      continue;
    }
    seenValues.add(value);
    options.push({ value, label: value });
  }
  return { OPTIONS: options, DEFAULT: options[0]?.value ?? OPENCODE_FALLBACK_MODELS.DEFAULT };
}

export function readOpenCodeSessionModel(sessionId?: string): string | null {
  if (!sessionId) {
    return null;
  }
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT model FROM session WHERE id = ?').get(sessionId) as
        | { model?: string }
        | undefined;
      return row?.model || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return buildOpenCodeModelsDefinition();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const model = readOpenCodeSessionModel(sessionId);
    if (model) {
      return { model };
    }
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('opencode', input);
  }
}
