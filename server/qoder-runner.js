/**
 * Qoder CLI Integration
 * =====================
 *
 * Drives the `qodercli` binary in headless print mode (`qodercli -p -o
 * stream-json`), parsing its NDJSON event stream into normalized live messages.
 * This mirrors `opencode-runner.js`'s role for opencode: qoder has no official
 * SDK for interactive sessions, so the runner spawns the CLI, streams events
 * over the WebSocket, and reports the provider-native session id via
 * `session_created` when a brand-new session announces one.
 *
 * ## Usage
 *
 * - queryQoder(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortQoderSession(sessionId) - Cancel an active session
 * - isQoderSessionActive(sessionId) - Check if a session is running
 * - getActiveQoderSessions() - List all active sessions
 */

import { spawn } from 'cross-spawn';

import { normalizeImageDescriptors } from './shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { QoderSessionsProvider } from './modules/providers/list/qoder/qoder-sessions.provider.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from './shared/utils.js';

const activeQoderProcesses = new Map();

// Session normalization lives on the provider facet; a single module-level
// instance is stateless beyond per-call message assembly.
const qoderSessions = new QoderSessionsProvider();

/**
 * Maps the UI permission mode onto Qoder's `--permission-mode` flag.
 *
 * Qoder exposes a single `--permission-mode` switch with snake_case values
 * (verified against `qodercli --help`):
 * - plan              → `plan`
 * - bypassPermissions → `bypass_permissions`
 * - acceptEdits       → `accept_edits`
 * - default           → nothing; the user's own Qoder config governs.
 *
 * Exported for tests only.
 */
export function resolveQoderPermissionOptions(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--permission-mode', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--permission-mode', 'bypass_permissions'], env: {} };
    case 'acceptEdits':
      return { args: ['--permission-mode', 'accept_edits'], env: {} };
    default:
      return { args: [], env: {} };
  }
}

/**
 * Reads the provider-native session id from a Qoder stream event.
 *
 * Qoder emits `session_id` (lowercase snake) on each NDJSON event, unlike
 * OpenCode's `sessionID`. The camelCase fallback keeps legacy transcript
 * variants working. Exported for tests only.
 */
export function readQoderSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.session_id || event.sessionId || null;
}

/**
 * Qoder accepts any of its fixed reasoning-effort values directly; there is no
 * model-catalog gate, so only the UI's `default` sentinel is filtered out.
 */
function resolveQoderEffort(effort) {
  return typeof effort === 'string' && effort !== 'default' ? effort : undefined;
}

/**
 * Assembles the full `qodercli` argument vector for a headless run.
 *
 * Exported for tests only.
 */
export function buildQoderArgs({
  workingDir,
  providerSessionId,
  model,
  effort,
  permissionMode,
  mcpConfigPath,
  attachments,
  prompt,
}) {
  const args = ['-p', '-o', 'stream-json'];
  args.push('--cwd', workingDir);
  if (providerSessionId) {
    args.push('--resume', providerSessionId);
  }
  if (model) {
    args.push('--model', model);
  }
  const resolvedEffort = resolveQoderEffort(effort);
  if (resolvedEffort) {
    args.push('--reasoning-effort', resolvedEffort);
  }
  const permissionOptions = resolveQoderPermissionOptions(permissionMode);
  args.push(...permissionOptions.args);
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      args.push('--attachment', attachment);
    }
  }
  const trimmedPrompt = prompt && prompt.trim();
  if (trimmedPrompt) {
    args.push(trimmedPrompt);
  }
  return args;
}

function sendMessage(ws, data) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[qoder-runner] send failed', error.message || error);
  }
}

export async function queryQoder(command, options = {}, ws) {
  return new Promise((resolve, reject) => {
    const {
      sessionId = null,
      projectPath,
      cwd = process.cwd(),
      model,
      effort,
      sessionSummary,
      images = [],
      files = [],
      permissionMode = 'default',
      mcpConfigPath,
    } = options;
    // Callers pass the provider-native session id (the chat gateway rewrites
    // options.sessionId from the session row's provider_session_id before
    // dispatch); the CLI resumes with that same id, no DB translation needed.
    const providerSessionId = sessionId;
    const workingDir = cwd || projectPath || process.cwd();
    // Process-map key: the app session id when the caller supplied one, so
    // abort-by-app-id always works.
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let qoderProcess = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    // A spawn failure fires BOTH the 'error' and 'close' handlers; this flag
    // dedupes the "Qoder CLI is not installed" hint so the user sees it once.
    let notInstalledSent = false;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'qoder',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'qoder',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Qoder CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      if (!sessionId && processKey !== capturedSessionId && qoderProcess) {
        activeQoderProcesses.delete(processKey);
        activeQoderProcesses.set(capturedSessionId, qoderProcess);
      }
      if (qoderProcess) {
        qoderProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        sendMessage(ws, createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'qoder',
        }));
      }
    };

    const processQoderOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        sendMessage(ws, createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'qoder',
        }));
        return;
      }

      try {
        registerSession(readQoderSessionId(response));

        // Qoder reports usage as credits on the terminal `result` event rather
        // than through a queryable database, so surface it inline as soon as it
        // arrives. `usage.input_tokens/output_tokens` are always 0.
        if (response.type === 'result') {
          const hasUsage = response.total_credits != null || response.total_cost_usd != null;
          if (hasUsage) {
            sendMessage(ws, createNormalizedMessage({
              kind: 'status',
              text: 'token_budget',
              tokenBudget: {
                credits: response.total_credits ?? 0,
                costUsd: response.total_cost_usd ?? 0,
                modelUsage: response.modelUsage,
                numTurns: response.num_turns,
                durationMs: response.duration_ms,
              },
              sessionId: capturedSessionId || sessionId || null,
              provider: 'qoder',
            }));
          }

          // Failed runs still emit a `result` event (subtype
          // `error_during_execution`); surface the CLI's error text so the
          // user sees why Qoder stopped.
          if (response.is_error || response.subtype === 'error_during_execution') {
            const errorText = response.errors?.[0] ?? response.result;
            if (errorText) {
              sendMessage(ws, createNormalizedMessage({
                kind: 'error',
                content: typeof errorText === 'string' ? errorText : JSON.stringify(errorText),
                sessionId: capturedSessionId || sessionId || null,
                provider: 'qoder',
              }));
            }
          }
        }

        const normalized = qoderSessions.normalizeMessage(response, capturedSessionId || sessionId || null);
        for (const msg of normalized) {
          sendMessage(ws, msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[Qoder] Failed to process JSON output:', errorContent);
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'qoder',
        }));
      }
    };

    // Qoder attaches files/images natively via `--attachment`, so the prompt
    // carries the raw text only (unlike OpenCode, which embeds
    // <files_input>/<images_input> tags because its CLI parses them).
    const attachmentPaths = [
      ...normalizeImageDescriptors(images).map((descriptor) => descriptor.path),
      ...normalizeImageDescriptors(files).map((descriptor) => descriptor.path),
    ];

    const args = buildQoderArgs({
      workingDir,
      providerSessionId,
      model,
      effort,
      permissionMode,
      mcpConfigPath,
      attachments: attachmentPaths,
      prompt: flattenPromptForWindowsShell(command?.trim() || ''),
    });

    const permissionOptions = resolveQoderPermissionOptions(permissionMode);

    qoderProcess = spawn('qodercli', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...permissionOptions.env },
    });

    activeQoderProcesses.set(processKey, qoderProcess);
    qoderProcess.sessionId = processKey;
    qoderProcess.stdin.end();

    qoderProcess.stdout.setEncoding('utf8');
    qoderProcess.stdout.on('data', (data) => {
      stdoutLineBuffer += data.toString();
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';

      completeLines.forEach((line) => {
        processQoderOutputLine(line.trim());
      });
    });

    qoderProcess.stderr.setEncoding('utf8');
    qoderProcess.stderr.on('data', (data) => {
      const stderrText = data.toString();
      if (!stderrText.trim()) {
        return;
      }

      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: stderrText,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'qoder',
      }));
    });

    qoderProcess.on('close', async (code) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeQoderProcesses.delete(finalSessionId);
      activeQoderProcesses.delete(processKey);

      if (stdoutLineBuffer.trim()) {
        processQoderOutputLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = '';
      }

      // Terminal complete — skipped for aborted runs (abort-session
      // already sent the aborted complete on this run's behalf).
      if (!completeSent && !qoderProcess.aborted) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({ provider: 'qoder', sessionId: finalSessionId, exitCode: code }));
      }

      if (code === 0) {
        notifyTerminalState({ code });
        resolve();
        return;
      }

      if (code === 127 || code === null) {
        const installed = await providerAuthService.isProviderInstalled('qoder');
        if (!installed && !notInstalledSent) {
          notInstalledSent = true;
          sendMessage(ws, createNormalizedMessage({
            kind: 'error',
            content: 'Qoder CLI is not installed. Install it with: npm i -g @qoder-ai/qodercli',
            sessionId: finalSessionId,
            provider: 'qoder',
          }));
        }
      }

      notifyTerminalState({ code });
      reject(new Error(code === null ? 'Qoder CLI process was terminated' : `Qoder CLI exited with code ${code}`));
    });

    qoderProcess.on('error', async (error) => {
      const finalSessionId = sessionId || capturedSessionId || processKey;
      activeQoderProcesses.delete(finalSessionId);
      activeQoderProcesses.delete(processKey);

      const installed = await providerAuthService.isProviderInstalled('qoder');
      const errorContent = !installed
        ? 'Qoder CLI is not installed. Install it with: npm i -g @qoder-ai/qodercli'
        : error.message;
      if (!installed) {
        notInstalledSent = true;
      }

      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: errorContent,
        sessionId: finalSessionId,
        provider: 'qoder',
      }));
      if (!completeSent && !qoderProcess.aborted) {
        completeSent = true;
        sendMessage(ws, createCompleteMessage({ provider: 'qoder', sessionId: finalSessionId, exitCode: 1 }));
      }
      notifyTerminalState({ error });
      reject(error);
    });
  });
}

/**
 * Aborts an active qoder run by killing its child process.
 * The abort-session handler emits the terminal `complete` (aborted: true)
 * on behalf of the run, so the close handler skips its own.
 */
export function abortQoderSession(sessionId) {
  const process = activeQoderProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  process.aborted = true;
  try {
    process.kill('SIGTERM');
  } catch {
    // already gone
  }
  activeQoderProcesses.delete(sessionId);
  return true;
}

export function isQoderSessionActive(sessionId) {
  return activeQoderProcesses.has(sessionId);
}

export function getActiveQoderSessions() {
  return Array.from(activeQoderProcesses.keys());
}