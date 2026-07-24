import express from 'express';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { sessionsDb } from '../modules/database/index.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';
import * as gitRewind from '../services/git-rewind.js';

const productionDeps = {
  sessionsDb,
  chatRunRegistry,
  forkSession,
  gitRewind,
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

/**
 * Rewind: fork the conversation to a chosen turn, then best-effort rewind
 * tracked files to the git commit at or before the turn's timestamp.
 * Returns { status, body } (body may include `warnings: string[]`).
 */
export async function rewindAppSession(deps, appId, { upToMessageId, turnTimestamp } = {}) {
  const forkResult = await forkAppSession(deps, appId, { upToMessageId, suffix: 'rewind' });
  if (forkResult.status !== 200) return forkResult;
  const warnings = [];
  const row = deps.sessionsDb.getSessionById(appId);
  const projectPath = row?.project_path;
  if (!projectPath) {
    return { ...forkResult, body: { ...forkResult.body, warnings } };
  }
  const git = deps.gitRewind;
  const isRepo = await git.isGitRepo(projectPath);
  if (!isRepo) {
    warnings.push('file-rewind:not-a-git-repo');
    return { ...forkResult, body: { ...forkResult.body, warnings } };
  }
  const commit = await git.findCommitAtOrBefore(projectPath, turnTimestamp);
  if (!commit) {
    warnings.push('file-rewind:no-covering-commit');
    return { ...forkResult, body: { ...forkResult.body, warnings } };
  }
  await git.rewindFilesToCommit(projectPath, commit);
  return { ...forkResult, body: { ...forkResult.body, warnings } };
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
  r.post('/:appId/rewind', async (req, res) => {
    try {
      const { status, body } = await rewindAppSession(deps, req.params.appId, {
        upToMessageId: req.body?.upToMessageId,
        turnTimestamp: req.body?.turnTimestamp,
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
