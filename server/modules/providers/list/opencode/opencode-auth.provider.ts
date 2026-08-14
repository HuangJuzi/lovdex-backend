import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

export class OpenCodeProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      spawnSync('opencode', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    let authenticated = false;
    let email: string | null = null;
    let method: string | null = null;
    let error: string | undefined;

    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    try {
      if (!fsSync.existsSync(authPath)) {
        error = 'opencode auth.json not found';
      } else {
        const auth = readObjectRecord(JSON.parse(fsSync.readFileSync(authPath, 'utf8'))) ?? {};
        const providerKeys = Object.keys(auth).filter((key) => key !== 'provider');
        if (providerKeys.length > 0) {
          authenticated = true;
          method = 'credentials_file';
          email = providerKeys.join(', ');
        } else {
          error = 'No credentials found in auth.json';
        }
      }
    } catch (readError) {
      error = readError instanceof Error ? readError.message : 'Failed to read auth.json';
    }

    return {
      installed,
      provider: 'opencode',
      authenticated,
      email,
      method,
      error: authenticated ? undefined : (error || 'Not authenticated'),
    };
  }
}
