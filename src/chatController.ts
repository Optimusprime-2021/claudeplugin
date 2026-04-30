import * as vscode from 'vscode';
import { ClaudeService } from './claudeService';
import { log } from './logger';
import { ChatConfig, HostToWebview, StreamEvent, WebviewToHost } from './types';

/**
 * Bridges N webviews (sidebar + panel) to a single long-lived ClaudeService.
 * The same conversation is reflected everywhere.
 */
export type ChatStatus = 'idle' | 'busy' | 'pending';

export class ChatController {
  private readonly service = new ClaudeService();
  private readonly webviews = new Set<vscode.Webview>();
  private readonly _statusEmitter = new vscode.EventEmitter<ChatStatus>();
  readonly onStatus = this._statusEmitter.event;
  private busy = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.service.on('event', (event: StreamEvent) => {
      this.beforeForwardEvent(event);
      this.broadcast({ type: 'event', event });
      if (event.type === 'result') {
        this.busy = false;
        this.broadcastState();
      }
    });
    this.service.on('end', () => {
      // Process exited (e.g. after stop(), or unexpected death). Clear busy.
      if (this.busy) {
        this.busy = false;
        this.broadcastState();
      }
    });
    this.service.on('error', (err: Error) => {
      log.error('Claude service error', err);
      this.busy = false;
      this.broadcast({ type: 'error', message: err.message ?? String(err) });
      this.broadcastState();
    });

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeCode')) this.broadcastConfig();
      })
    );
  }

  attach(webview: vscode.Webview): vscode.Disposable {
    this.webviews.add(webview);
    const sub = webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
    // Warm up the CLI process so the first user turn is instant.
    this.service.warmup();
    queueMicrotask(() => {
      this.sendTo(webview, { type: 'config', config: this.chatConfig() });
      this.sendTo(webview, this.stateMessage());
    });
    return new vscode.Disposable(() => {
      this.webviews.delete(webview);
      sub.dispose();
    });
  }

  pushMention(text: string): void {
    this.broadcast({ type: 'mention', text });
  }

  newConversation(): void {
    this.service.reset();
    this.busy = false;
    this.broadcast({ type: 'cleared' });
    this.broadcastState();
    // Warm up a fresh process for the new conversation.
    this.service.warmup();
  }

  resume(sessionId: string): void {
    this.service.setSessionId(sessionId);
    this.busy = false;
    this.broadcast({ type: 'cleared' });
    this.broadcastState();
    this.service.warmup();
  }

  continueLast(): void {
    this.newConversation();
  }

  stop(): void {
    this.service.stop();
    this.busy = false;
    this.broadcastState();
  }

  dispose(): void {
    this.service.dispose();
    this.webviews.clear();
  }

  private onMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.broadcastConfig();
        this.broadcastState();
        return;
      case 'send':
        this.handleSend(msg.text);
        return;
      case 'stop':
        this.stop();
        return;
      case 'newConversation':
        this.newConversation();
        return;
      case 'resume':
        if (msg.sessionId) this.resume(msg.sessionId);
        else void this.promptResume();
        return;
      case 'continue':
        this.continueLast();
        return;
      case 'setModel':
        this.setModel(msg.model);
        return;
      case 'setPermissionMode':
        this.setPermissionMode(msg.mode);
        return;
      case 'openDiff':
        void this.openDiff(msg.filePath, msg.oldStr, msg.newStr);
        return;
      case 'openFile':
        void this.openFile(msg.filePath);
        return;
      case 'applyEdit':
        void this.applyEdit(msg.filePath, msg.content);
        return;
      case 'copyToClipboard':
        void vscode.env.clipboard.writeText(msg.text);
        return;
      case 'searchFiles':
        void this.searchFiles(msg.query);
        return;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.claude-code-cli');
        return;
      case 'requestDiagnostics':
        void this.shareDiagnostics();
        return;
      case 'requestTerminalOutput':
        void this.shareTerminalOutput(msg.name);
        return;
      case 'login':
        this.handleSend('/login');
        return;
      case 'logout':
        void vscode.commands.executeCommand('claudeCode.logout');
        return;
      case 'usage':
        this.handleSend('/usage');
        return;
      case 'compact':
        this.handleSend('/compact');
        return;
      case 'mcp':
        this.handleSend('/mcp');
        return;
      case 'plugins':
        this.handleSend('/plugins');
        return;
      case 'openWalkthrough':
        void vscode.commands.executeCommand('claudeCode.openWalkthrough');
        return;
      case 'attachFiles': {
        if (!msg.files || !msg.files.length) return;
        const mention = msg.files.map((f) => `@${vscode.workspace.asRelativePath(f.path, false)}`).join(' ');
        this.broadcast({ type: 'mention', text: mention + ' ' });
        return;
      }
    }
  }

  setModel(model: string): void {
    this.service.setModelOverride(model);
    this.busy = false;
    this.broadcastState();
    this.service.warmup();
  }

  setPermissionMode(mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'): void {
    this.service.setPermissionModeOverride(mode);
    this.busy = false;
    this.broadcastState();
    this.service.warmup();
  }

  private async openDiff(filePath: string, oldStr: string, newStr: string): Promise<void> {
    try {
      const left = await this.makeVirtualDoc(oldStr, filePath, 'before');
      const right = await this.makeVirtualDoc(newStr, filePath, 'after');
      const title = `${labelForPath(filePath)} (proposed edit)`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    } catch (err) {
      log.error('Failed to open diff', err);
      this.broadcast({ type: 'error', message: 'Failed to open diff: ' + (err as Error).message });
    }
  }

  private async makeVirtualDoc(content: string, filePath: string, suffix: string): Promise<vscode.Uri> {
    const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '.txt';
    const tmp = vscode.Uri.parse(`untitled:${labelForPath(filePath)}.${suffix}${ext}`);
    const doc = await vscode.workspace.openTextDocument({ content, language: languageFromExt(ext) });
    void doc;
    // We'd ideally use a content-provider URI, but openTextDocument({content}) returns a fresh untitled doc
    // we can pass directly. Re-fetch the URI from the just-opened doc.
    return doc.uri;
    void tmp;
  }

  private async openFile(filePath: string): Promise<void> {
    try {
      const uri = await this.resolveFileUri(filePath);
      if (!uri) {
        this.broadcast({ type: 'error', message: `File not found: ${filePath}` });
        return;
      }
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (err) {
      this.broadcast({ type: 'error', message: 'Failed to open file: ' + (err as Error).message });
    }
  }

  private async applyEdit(filePath: string, content: string): Promise<void> {
    try {
      const uri = await this.resolveFileUri(filePath);
      const targetUri = uri ?? this.targetUriForNewFile(filePath);
      if (!targetUri) {
        this.broadcast({ type: 'error', message: 'No workspace folder open to write into.' });
        return;
      }
      const enc = new TextEncoder();
      await vscode.workspace.fs.writeFile(targetUri, enc.encode(content));
      await vscode.window.showTextDocument(targetUri, { preview: true });
    } catch (err) {
      this.broadcast({ type: 'error', message: 'Failed to apply edit: ' + (err as Error).message });
    }
  }

  private async searchFiles(query: string): Promise<void> {
    const cleaned = (query ?? '').trim();
    if (!cleaned) {
      this.broadcast({ type: 'fileSuggestions', query: cleaned, results: [] });
      return;
    }
    try {
      const include = `**/*${cleaned}*`;
      const respectGitIgnore = vscode.workspace.getConfiguration('claudeCode').get<boolean>('respectGitIgnore', true);
      const exclude = respectGitIgnore ? null : '**/node_modules/**';
      // findFiles' second arg null means "use VS Code's search.exclude + .gitignore".
      const found = await vscode.workspace.findFiles(include, exclude as string | null, 12);
      const results = found.map((u) => {
        const rel = vscode.workspace.asRelativePath(u, false);
        return { path: u.fsPath, relPath: rel };
      });
      this.broadcast({ type: 'fileSuggestions', query: cleaned, results });
    } catch (err) {
      log.warn('searchFiles failed', err);
      this.broadcast({ type: 'fileSuggestions', query: cleaned, results: [] });
    }
  }

  private beforeForwardEvent(event: StreamEvent): void {
    // Autosave dirty editors before Claude reads or writes any file.
    if (event.type === 'assistant') {
      const blocks = (event as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(blocks) && blocks.some(isFileTool) && this.autosaveEnabled()) {
        void vscode.workspace.saveAll(false);
      }
    }
    // Plan-mode: when Claude emits an ExitPlanMode tool with a markdown plan, surface it.
    if (event.type === 'assistant') {
      const blocks = (event as { message?: { content?: { type?: string; name?: string; input?: { plan?: string } }[] } }).message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && b.type === 'tool_use' && b.name === 'ExitPlanMode' && typeof b.input?.plan === 'string') {
            this.broadcast({ type: 'plan', markdown: b.input.plan });
            void this.openPlanInEditor(b.input.plan);
          }
        }
      }
    }
  }

  private autosaveEnabled(): boolean {
    return vscode.workspace.getConfiguration('claudeCode').get<boolean>('autosave', true);
  }

  private async openPlanInEditor(markdown: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (err) {
      log.warn('openPlanInEditor failed', err);
    }
  }

  async shareDiagnostics(): Promise<void> {
    const all = vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diags] of all) {
      if (!diags.length) continue;
      const rel = vscode.workspace.asRelativePath(uri, false);
      for (const d of diags) {
        const sev = severityName(d.severity);
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        lines.push(`${rel}:${line}:${col}  [${sev}]  ${d.message}${d.source ? ` (${d.source})` : ''}`);
      }
    }
    const text = lines.length ? lines.join('\n') : 'No diagnostics in the current workspace.';
    this.broadcast({ type: 'diagnostics', text });
  }

  async shareTerminalOutput(_name?: string): Promise<void> {
    const term = vscode.window.activeTerminal;
    if (!term) {
      this.broadcast({ type: 'error', message: 'No active terminal.' });
      return;
    }
    // VS Code does not expose a terminal buffer API. We capture the user's current
    // selection via the built-in "copy selection" command, then read the clipboard.
    const prevClipboard = await vscode.env.clipboard.readText();
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      const captured = await vscode.env.clipboard.readText();
      if (captured && captured !== prevClipboard) {
        this.broadcast({ type: 'terminalOutput', name: term.name, text: captured });
      } else {
        this.broadcast({ type: 'error', message: 'Select text in the terminal first, then re-run this command.' });
      }
    } finally {
      // Restore the clipboard so we don't trample the user's previous copy.
      await vscode.env.clipboard.writeText(prevClipboard);
    }
  }

  private async resolveFileUri(filePath: string): Promise<vscode.Uri | null> {
    if (!filePath) return null;
    if (isAbsolutePath(filePath)) {
      const abs = vscode.Uri.file(filePath);
      try {
        await vscode.workspace.fs.stat(abs);
        return abs;
      } catch {
        // Absolute path that doesn't exist yet — caller decides whether to create it.
        return null;
      }
    }
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf) return null;
    const candidate = vscode.Uri.joinPath(wf.uri, filePath);
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  private targetUriForNewFile(filePath: string): vscode.Uri | null {
    if (!filePath) return null;
    if (isAbsolutePath(filePath)) return vscode.Uri.file(filePath);
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf) return null;
    return vscode.Uri.joinPath(wf.uri, filePath);
  }

  private handleSend(text: string): void {
    if (!text || !text.trim()) return;
    if (this.busy) {
      this.broadcast({ type: 'error', message: 'A turn is already in progress.' });
      return;
    }
    this.busy = true;
    this.broadcastState();

    // Echo user message so it shows immediately in the UI.
    this.broadcast({
      type: 'event',
      event: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      },
    });

    this.service.send(text);
  }

  private async promptResume(): Promise<void> {
    const sessionId = await vscode.window.showInputBox({
      prompt: 'Enter a Claude Code session ID to resume',
      placeHolder: 'e.g. 4f8a2c1d-9b6e-...',
      validateInput: (v) => (v && v.trim().length > 8 ? null : 'Enter a valid session id'),
    });
    if (sessionId) this.resume(sessionId.trim());
  }

  private broadcast(msg: HostToWebview): void {
    for (const webview of this.webviews) this.sendTo(webview, msg);
  }

  private sendTo(webview: vscode.Webview, msg: HostToWebview): void {
    void webview.postMessage(msg);
  }

  private stateMessage(): HostToWebview {
    return {
      type: 'state',
      busy: this.busy,
      sessionId: this.service.currentSessionId,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      model: this.service.currentModel || 'default',
      permissionMode: this.service.currentPermissionMode,
    };
  }

  private broadcastState(): void {
    this.broadcast(this.stateMessage());
    this._statusEmitter.fire(this.busy ? 'busy' : 'idle');
  }

  private broadcastConfig(): void {
    this.broadcast({ type: 'config', config: this.chatConfig() });
  }

  private chatConfig(): ChatConfig {
    const c = vscode.workspace.getConfiguration('claudeCode');
    return {
      useCtrlEnterToSend: c.get<boolean>('useCtrlEnterToSend', false),
      hideOnboarding: c.get<boolean>('hideOnboarding', false),
      allowDangerouslySkipPermissions: c.get<boolean>('allowDangerouslySkipPermissions', false),
      disableLoginPrompt: c.get<boolean>('disableLoginPrompt', false),
    };
  }
}

function isFileTool(b: unknown): boolean {
  if (!b || typeof b !== 'object') return false;
  const block = b as { type?: string; name?: string };
  if (block.type !== 'tool_use') return false;
  return block.name === 'Read' || block.name === 'Write' || block.name === 'Edit' || block.name === 'NotebookEdit';
}

function severityName(s: vscode.DiagnosticSeverity | undefined): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'note';
  }
}

function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function labelForPath(filePath: string): string {
  if (!filePath) return 'edit';
  const norm = filePath.replace(/\\/g, '/');
  return norm.split('/').pop() || norm;
}

function languageFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescriptreact',
    '.js': 'javascript', '.jsx': 'javascriptreact',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
    '.html': 'html', '.css': 'css', '.scss': 'scss',
    '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml',
    '.md': 'markdown', '.sh': 'shellscript', '.bash': 'shellscript',
    '.toml': 'toml', '.xml': 'xml', '.sql': 'sql',
  };
  return map[ext.toLowerCase()] || 'plaintext';
}
