import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { SophcodeProviderAuth } from '@/modules/providers/list/sophcode/sophcode-auth.provider.js';
import { SophcodeMcpProvider } from '@/modules/providers/list/sophcode/sophcode-mcp.provider.js';
import { SophcodeProviderModels } from '@/modules/providers/list/sophcode/sophcode-models.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class SophcodeProvider extends AbstractProvider {
  readonly models: IProviderModels = new SophcodeProviderModels();
  readonly mcp: IProviderMcp = new SophcodeMcpProvider();
  readonly auth: IProviderAuth = new SophcodeProviderAuth();
  readonly skills = undefined as unknown as IProviderSkills;
  readonly sessions = undefined as unknown as IProviderSessions;
  readonly sessionSynchronizer = undefined as unknown as IProviderSessionSynchronizer;

  constructor() {
    super('sophcode');
  }
}