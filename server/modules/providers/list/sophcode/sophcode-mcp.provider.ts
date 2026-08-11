import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

/**
 * Strips `//` and `/* ... *​/` comments (string-aware: `https://` inside a
 * string literal is preserved) and trailing commas so JSONC parses as JSON.
 */
export function stripJsoncComments(content: string): string {
  let result = '';
  let inString = false;
  let inBlockComment = false;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === '\\') {
        if (next !== undefined) {
          result += next;
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && content[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}

const readJsoncConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return readObjectRecord(JSON.parse(stripJsoncComments(content))) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const writeJsonConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
};

export class SophcodeMcpProvider extends McpProvider {
  constructor() {
    super('sophcode', ['user', 'project'], ['stdio', 'http']);
  }

  private configPath(scope: McpScope, workspacePath: string): string {
    return scope === 'user'
      ? path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc')
      : path.join(workspacePath, 'opencode.json');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsoncConfig(this.configPath(scope, workspacePath));
    return readObjectRecord(config.mcp) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const config = await readJsoncConfig(this.configPath(scope, workspacePath));
    config.mcp = servers;
    await writeJsonConfig(this.configPath(scope, workspacePath), config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }
      return {
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        environment: input.env ?? {},
      };
    }
    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }
    return {
      type: 'remote',
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }
    const config = rawConfig as Record<string, unknown>;
    if (config.type === 'local' || Array.isArray(config.command)) {
      const commandArr = readStringArray(config.command) ?? [];
      return {
        provider: 'sophcode',
        name,
        scope,
        transport: 'stdio',
        command: commandArr[0],
        args: commandArr.slice(1),
        env: readStringRecord(config.environment),
      };
    }
    if (config.type === 'remote' || typeof config.url === 'string') {
      return {
        provider: 'sophcode',
        name,
        scope,
        transport: 'http',
        url: readOptionalString(config.url),
        headers: readStringRecord(config.headers),
      };
    }
    return null;
  }
}
