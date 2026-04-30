import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './logger';
import { StreamEvent } from './types';

/**
 * Manages a long-lived `claude` CLI process running in stream-json input/output mode.
 *
 * The CLI is spawned ONCE on the first send (or via warmup()) and stays resident,
 * receiving subsequent user messages on stdin and emitting events on stdout.
 * This eliminates the per-turn process startup cost (~1-3s) that you'd pay if
 * we re-spawned for every send.
 *
 * The process is restarted only on:
 *   - `reset()` — new conversation
 *   - explicit `setSessionId()` to resume a different session
 *   - process death (auto-respawn on next send)
 */
export class ClaudeService extends EventEmitter {
  private current: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | null = null;
  private resumeOnRespawn: string | null = null;
  private modelOverride: string | null = null;
  private permissionModeOverride: string | null = null;
  private buffer = '';
  private busy = false;

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get currentModel(): string {
    if (this.modelOverride) return this.modelOverride;
    return (vscode.workspace.getConfiguration('claudeCode').get<string>('model') ?? '').trim();
  }

  get isRunning(): boolean {
    return this.busy;
  }

  /** Override the model for subsequent turns. Forces a respawn so the CLI picks up the new --model. */
  setModelOverride(model: string | null): void {
    const next = model && model.trim() ? model.trim() : null;
    if (next === this.modelOverride) return;
    this.modelOverride = next;
    // Preserve session so the new model picks up the same conversation.
    this.resumeOnRespawn = this.sessionId;
    this.killProcess();
  }

  get currentPermissionMode(): string {
    if (this.permissionModeOverride) return this.permissionModeOverride;
    return vscode.workspace.getConfiguration('claudeCode').get<string>('permissionMode') || 'default';
  }

  setPermissionModeOverride(mode: string | null): void {
    const next = mode && mode.trim() ? mode.trim() : null;
    if (next === this.permissionModeOverride) return;
    this.permissionModeOverride = next;
    this.resumeOnRespawn = this.sessionId;
    this.killProcess();
  }

  /** Pre-spawn the CLI so the first user turn has zero startup latency. */
  warmup(): void {
    if (!this.current) this.spawnProcess();
  }

  reset(): void {
    this.killProcess();
    this.sessionId = null;
    this.resumeOnRespawn = null;
  }

  setSessionId(id: string | null): void {
    if (this.sessionId === id) return;
    // Resuming a different session needs a fresh process spawned with --resume.
    this.sessionId = id;
    this.resumeOnRespawn = id;
    this.killProcess();
  }

  /** Cancel the in-flight turn. We have to tear down the process — there is no
   * mid-turn interrupt protocol over stdin. */
  stop(): void {
    if (!this.busy && !this.current) return;
    // Preserve the session id so the next send resumes where we left off.
    this.resumeOnRespawn = this.sessionId;
    this.killProcess();
    this.busy = false;
    this.emit('end', { code: null, signal: 'SIGTERM' });
  }

  send(text: string): void {
    if (this.busy) {
      this.emit('error', new Error('A Claude turn is already in progress.'));
      return;
    }
    let proc = this.current;
    if (!proc) proc = this.spawnProcess();
    if (!proc) return; // spawnProcess emitted error already

    this.busy = true;
    const message = { type: 'user', message: { role: 'user', content: text } };
    try {
      proc.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      log.error('Failed to write to claude stdin', err);
      this.busy = false;
      this.emit('error', err);
    }
  }

  dispose(): void {
    this.removeAllListeners();
    this.killProcess();
  }

  private killProcess(): void {
    if (this.current) {
      try {
        this.current.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        this.current.kill();
      } catch (err) {
        log.warn('Failed to kill claude process', err);
      }
      this.current = null;
    }
    this.buffer = '';
  }

  private spawnProcess(): ChildProcessWithoutNullStreams | null {
    const cli = resolveCliPath();
    if (!cli) {
      this.emit(
        'error',
        new Error(
          'Could not find the `claude` CLI. Install it from https://docs.claude.com/claude-code or set claudeCode.cliPath in settings.'
        )
      );
      return null;
    }

    const cwd = firstWorkspaceCwd() ?? process.cwd();
    const config = vscode.workspace.getConfiguration('claudeCode');

    const args: string[] = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];

    const model = this.modelOverride ?? (config.get<string>('model') ?? '').trim();
    if (model) args.push('--model', model);

    const initialMode = (config.get<string>('initialPermissionMode') || '').trim();
    const legacyMode = (config.get<string>('permissionMode') || '').trim();
    const baseMode = initialMode && initialMode !== 'default' ? initialMode : legacyMode;
    const permissionMode = this.permissionModeOverride ?? baseMode ?? 'default';
    const allowBypass = config.get<boolean>('allowDangerouslySkipPermissions', false);
    if (permissionMode === 'bypassPermissions' && !allowBypass) {
      log.warn('bypassPermissions requested but allowDangerouslySkipPermissions is false — falling back to default mode');
    } else if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
    }
    if (config.get<boolean>('disableLoginPrompt', false)) {
      // The CLI honors this env to skip the interactive sign-in path.
      // (Provider creds are expected to come from ~/.claude/settings.json.)
    }

    const sessionToResume = this.resumeOnRespawn;
    if (sessionToResume) args.push('--resume', sessionToResume);
    this.resumeOnRespawn = null;

    const extraArgs = config.get<string[]>('additionalArgs') ?? [];
    for (const arg of extraArgs) {
      if (typeof arg === 'string' && arg.length) args.push(arg);
    }

    const env = buildEnv(config);

    const wrapper = (config.get<string>('claudeProcessWrapper') || '').trim();
    const finalCmd = wrapper || cli;
    const finalArgs = wrapper ? [cli, ...args] : args;
    log.info(`spawn (long-lived): ${finalCmd} ${finalArgs.join(' ')} (cwd=${cwd})`);

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(finalCmd, finalArgs, { cwd, env, shell: false, windowsHide: true });
    } catch (err) {
      this.emit('error', err);
      return null;
    }

    this.current = proc;
    this.buffer = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    proc.stderr.on('data', (chunk: string) => log.warn(`[claude:stderr] ${chunk.trim()}`));

    proc.on('error', (err) => {
      log.error('claude process error', err);
      this.busy = false;
      this.current = null;
      this.emit('error', err);
    });

    proc.on('close', (code, signal) => {
      if (this.buffer.trim()) this.consumeLine(this.buffer);
      this.buffer = '';
      const wasBusy = this.busy;
      this.busy = false;
      this.current = null;
      log.info(`claude process exited (code=${code}, signal=${signal ?? 'none'})`);
      // If the process died unexpectedly mid-turn, surface as an error.
      if (wasBusy && (code ?? 0) !== 0) {
        this.emit('error', new Error(`claude process exited (code=${code}, signal=${signal ?? 'none'})`));
      }
      this.emit('end', { code, signal });
    });

    return proc;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      log.warn('Failed to parse stream-json line', { line: trimmed.slice(0, 200) });
      return;
    }

    // Track session id from any event that carries one.
    if (event.type === 'system' && (event as any).subtype === 'init' && (event as any).session_id) {
      this.sessionId = (event as any).session_id as string;
    } else if ((event as any).session_id) {
      this.sessionId = (event as any).session_id as string;
    }

    // The 'result' event marks turn end — clear busy so the next send is accepted.
    if (event.type === 'result') this.busy = false;

    this.emit('event', event);
  }
}

function buildEnv(config: vscode.WorkspaceConfiguration): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const extras = config.get<Array<{ name: string; value: string }>>('environmentVariables') ?? [];
  for (const entry of extras) {
    if (entry && typeof entry.name === 'string' && entry.name.length) {
      env[entry.name] = entry.value;
    }
  }
  return env;
}

function firstWorkspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveCliPath(): string | null {
  const config = vscode.workspace.getConfiguration('claudeCode');
  const explicit = (config.get<string>('cliPath') ?? '').trim();
  if (explicit) return explicit;

  const home = os.homedir();
  const candidates = [
    process.platform === 'win32' ? path.join(home, '.local', 'bin', 'claude.exe') : null,
    process.platform === 'win32' ? path.join(home, '.local', 'bin', 'claude') : null,
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ].filter(Boolean) as string[];

  const fs = require('fs') as typeof import('fs');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }

  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}
