import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { SophcodeProviderAuth } from '@/modules/providers/list/sophcode/sophcode-auth.provider.js';
import { SophcodeMcpProvider } from '@/modules/providers/list/sophcode/sophcode-mcp.provider.js';
import { SophcodeProviderModels } from '@/modules/providers/list/sophcode/sophcode-models.provider.js';
import { SophcodeSessionSynchronizer } from '@/modules/providers/list/sophcode/sophcode-session-synchronizer.provider.js';
import { SophcodeSessionsProvider } from '@/modules/providers/list/sophcode/sophcode-sessions.provider.js';
import { SophcodeSkillsProvider } from '@/modules/providers/list/sophcode/sophcode-skills.provider.js';
import type { IProviderAuth, IProviderMcp, IProviderModels, IProviderSkills, IProviderSessions } from '@/shared/interfaces.js';

export class SophcodeProvider extends AbstractProvider {
  readonly models: IProviderModels = new SophcodeProviderModels();
  readonly mcp: IProviderMcp = new SophcodeMcpProvider();
  readonly auth: IProviderAuth = new SophcodeProviderAuth();
  readonly skills: IProviderSkills = new SophcodeSkillsProvider();
  readonly sessions: IProviderSessions = new SophcodeSessionsProvider();
  readonly sessionSynchronizer = new SophcodeSessionSynchronizer();

  constructor() {
    super('sophcode');
  }
}