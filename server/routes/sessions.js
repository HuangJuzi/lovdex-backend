import express from 'express';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { sessionsDb } from '../modules/database/index.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';

const productionDeps = {
  sessionsDb,
  chatRunRegistry,
  forkSession,
};

/**
 * Fork an app session into a new one via the SDK's forkSession.
 * Returns { status, body } so it can be unit-tested with injected deps.
 */
export async function forkAppSession(deps, appId, { upToMessageId, suffix } = {}) {
  const { sessionsDb: db, chatRunRegistry: reg, forkSession: fork } = deps;
  const row = db.getSessionById(appId);
  if (!row) return { status: 404, body: { error: { message: 'Session not found' } } };
  if (!row.provider_session_id) {
    return { status: 409, body: { error: { code: 'SESSION_NOT_STARTED', message: 'Conversation has not started yet' } } };
  }
  if (row.provider !== 'claude') {
    return { status: 409, body: { error: { code: 'UNSUPPORTED_PROVIDER', message: 'Not supported for this provider' } } };
  }
  if (reg.isProcessing(appId)) {
    return { status: 409, body: { error: { code: 'RUN_IN_PROGRESS', message: 'Stop the running response first' } } };
  }
  const { sessionId: newProviderId } = await fork(
    row.provider_session_id,
    upToMessageId ? { upToMessageId } : undefined,
  );
  const newAppId = db.createAppSession(row.provider, row.project_path);
  const baseName = row.custom_name || row.summary || 'Session';
  db.updateSessionCustomName(newAppId, `${baseName} (${suffix})`);
  db.assignProviderSessionId(newAppId, newProviderId);
  return { status: 200, body: { newSessionId: newAppId, providerSessionId: newProviderId } };
}

function buildRouter(deps) {
  const r = express.Router();
  r.post('/:appId/fork', async (req, res) => {
    try {
      const { status, body } = await forkAppSession(deps, req.params.appId, {
        upToMessageId: req.body?.upToMessageId,
        suffix: 'fork',
      });
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
  return r;
}

export const sessionsRouter = (deps) => buildRouter(deps ?? productionDeps);
export default buildRouter(productionDeps);
