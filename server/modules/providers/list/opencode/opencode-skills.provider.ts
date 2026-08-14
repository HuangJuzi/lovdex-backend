import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
} from '@/shared/utils.js';

const COMPAT_DIRS = ['.opencode', '.claude', '.agents'];

export class OpenCodeSkillsProvider extends SkillsProvider {
  constructor() {
    super('opencode');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    // cwd-to-topmost-git-root `.opencode/.claude/.agents/skills` locations.
    for (const compatDir of COMPAT_DIRS) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'project',
        rootDir: path.join(workspacePath, compatDir, 'skills'),
        commandPrefix: '/',
      });
    }

    if (repoRoot) {
      for (const compatDir of COMPAT_DIRS) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(path.dirname(workspacePath), compatDir, 'skills'),
          commandPrefix: '/',
        });
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(repoRoot, compatDir, 'skills'),
          commandPrefix: '/',
        });
      }
    }

    // Global OpenCode/Claude/Agents compatibility locations.
    for (const compatDir of COMPAT_DIRS) {
      const rootDir = compatDir === '.opencode'
        ? path.join(os.homedir(), '.config', 'opencode', 'skills')
        : path.join(os.homedir(), compatDir, 'skills');
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir,
        commandPrefix: '/',
      });
    }

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.config', 'opencode', 'skills'),
      commandPrefix: '/',
    };
  }
}
