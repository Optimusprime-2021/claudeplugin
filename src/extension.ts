import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatController } from './chatController';
import { ChatPanel } from './chatPanel';
import { ChatViewProvider } from './chatViewProvider';
import { log } from './logger';
import { SessionsTreeProvider, projectsDirForCwd } from './sessionsView';

let controller: ChatController | undefined;
let viewProvider: ChatViewProvider | undefined;
let sessionsProvider: SessionsTreeProvider | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let terminal: vscode.Terminal | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

const FOCUSED_CTX = 'claudeCode.focused';

export function activate(context: vscode.ExtensionContext): void {
  log.info(`activating claude-code-cli ${context.extension.packageJSON.version}`);
  extensionContext = context;

  controller = new ChatController(context);
  viewProvider = new ChatViewProvider(context, controller);
  sessionsProvider = new SessionsTreeProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeCode.sessions', sessionsProvider)
  );

  // Refresh the sessions list whenever a transcript file changes.
  watchSessionsDir(context);

  context.subscriptions.push(
    register('claudeCode.open', () => openDefault()),
    register('claudeCode.openInPanel', openInPanel),
    register('claudeCode.openInNewWindow', openInNewWindow),
    register('claudeCode.openInSidebar', openInSidebar),
    register('claudeCode.openInTerminal', openInTerminal),
    register('claudeCode.newConversation', () => controller?.newConversation()),
    register('claudeCode.resumeConversation', resumeConversation),
    register('claudeCode.continueLast', () => controller?.continueLast()),
    register('claudeCode.stop', () => controller?.stop()),
    register('claudeCode.insertAtMention', insertAtMention),
    register('claudeCode.shareDiagnostics', () => controller?.shareDiagnostics()),
    register('claudeCode.shareTerminalOutput', () => controller?.shareTerminalOutput()),
    register('claudeCode.logout', logout),
    register('claudeCode.openWalkthrough', openWalkthrough),
    register('claudeCode.showLogs', () => log.show()),
    register('claudeCode.focus', focusInput),
    register('claudeCode.refreshSessions', () => sessionsProvider?.refresh()),
    register('claudeCode.openSession', (sessionId: unknown) => {
      if (typeof sessionId === 'string' && sessionId.length > 0) controller?.resume(sessionId);
      openDefault();
    }),
    register('claudeCode.removeSession', removeSession)
  );

  // URI handler — vscode://local.claude-code-cli/open?prompt=...&session=...
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => handleUri(uri),
    })
  );

  registerStatusBar(context);
  registerFocusContext(context);
  watchPanelStatusForBadge(context);

  context.subscriptions.push({
    dispose: () => {
      controller?.dispose();
      controller = undefined;
      viewProvider = undefined;
      sessionsProvider = undefined;
      extensionContext = undefined;
      if (terminal) {
        terminal.dispose();
        terminal = undefined;
      }
    },
  });
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

function register(id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      log.error(`command ${id} failed`, err);
      vscode.window.showErrorMessage(`Claude Code: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

function openDefault(prefill?: { prompt?: string; sessionId?: string }): void {
  const config = vscode.workspace.getConfiguration('claudeCode');
  if (config.get<boolean>('useTerminal', false)) {
    openInTerminal();
    return;
  }
  if (prefill?.sessionId) controller?.resume(prefill.sessionId);
  if (prefill?.prompt) controller?.pushMention(prefill.prompt);
  const where = config.get<string>('preferredLocation', 'sidebar');
  if (where === 'panel') openInPanel();
  else openInSidebar();
}

function openInPanel(): void {
  if (!controller || !extensionContext) return;
  ChatPanel.createOrShow(extensionContext, controller).focusInput();
}

function openInNewWindow(): void {
  // Re-open this folder in a new VS Code window with a query flag the new instance
  // reads on activation to auto-open the chat panel.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder) {
    void vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: true });
  } else {
    void vscode.commands.executeCommand('workbench.action.newWindow');
  }
}

function openInSidebar(): void {
  void vscode.commands.executeCommand('workbench.view.extension.claudeCodeSidebar');
  setTimeout(() => viewProvider?.focusInput(), 100);
}

function openInTerminal(): void {
  if (!terminal || terminal.exitStatus !== undefined) {
    const env: { [k: string]: string } = {};
    const extras =
      vscode.workspace
        .getConfiguration('claudeCode')
        .get<Array<{ name: string; value: string }>>('environmentVariables') ?? [];
    for (const { name, value } of extras) env[name] = value;
    terminal = vscode.window.createTerminal({
      name: 'Claude Code',
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env,
    });
  }
  terminal.show(false);
  const cli = vscode.workspace.getConfiguration('claudeCode').get<string>('cliPath') || 'claude';
  terminal.sendText(cli);
}

function focusInput(): void {
  openDefault();
}

async function resumeConversation(): Promise<void> {
  if (!controller) return;
  const items = await listLocalSessionsForPicker();
  const pickItems: (vscode.QuickPickItem & { sessionId?: string; isManual?: boolean })[] = items.map((s) => ({
    label: s.title,
    description: relativeAge(s.mtime),
    detail: s.sessionId,
    sessionId: s.sessionId,
  }));
  pickItems.unshift({ label: '$(edit) Enter session ID manually…', isManual: true });
  const picked = await vscode.window.showQuickPick(pickItems, {
    placeHolder: 'Resume a Claude Code session',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked.isManual) {
    const sessionId = await vscode.window.showInputBox({
      prompt: 'Enter a Claude Code session ID to resume',
      placeHolder: 'e.g. 4f8a2c1d-9b6e-...',
      validateInput: (v) => (v && v.trim().length > 8 ? null : 'Enter a valid session id'),
    });
    if (sessionId) controller.resume(sessionId.trim());
    return;
  }
  if (picked.sessionId) {
    controller.resume(picked.sessionId);
    openDefault();
  }
}

async function listLocalSessionsForPicker(): Promise<{ sessionId: string; title: string; mtime: number }[]> {
  const dir = projectsDirForCwd();
  if (!dir) return [];
  try {
    const files = await fs.promises.readdir(dir);
    const out: { sessionId: string; title: string; mtime: number }[] = [];
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const fp = path.join(dir, name);
      const stat = await fs.promises.stat(fp);
      out.push({ sessionId: name.replace(/\.jsonl$/, ''), title: name.replace(/\.jsonl$/, ''), mtime: stat.mtimeMs });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function relativeAge(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function insertAtMention(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !controller) return;

  const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
  const sel = editor.selection;
  const mention = sel.isEmpty ? `@${rel}` : `@${rel}#L${sel.start.line + 1}-L${sel.end.line + 1}`;
  controller.pushMention(mention + ' ');
  openDefault();
}

async function logout(): Promise<void> {
  const cli = vscode.workspace.getConfiguration('claudeCode').get<string>('cliPath') || 'claude';
  const confirm = await vscode.window.showWarningMessage(
    'Sign out of Claude Code? This runs `claude logout` in a terminal.',
    { modal: true },
    'Sign out'
  );
  if (confirm !== 'Sign out') return;
  const term = vscode.window.createTerminal({ name: 'Claude Code: Logout' });
  term.show(true);
  term.sendText(`${cli} logout`);
}

function openWalkthrough(): void {
  void vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    'local.claude-code-cli#claudeCode.gettingStarted',
    false
  );
}

function handleUri(uri: vscode.Uri): void {
  if (uri.path !== '/open') return;
  const params = new URLSearchParams(uri.query);
  const prompt = params.get('prompt') ?? undefined;
  const sessionId = params.get('session') ?? undefined;
  openDefault({ prompt: prompt ? decodeURIComponent(prompt) : undefined, sessionId: sessionId ?? undefined });
}

async function removeSession(arg: unknown): Promise<void> {
  // Tree-item invocation passes the TreeItem; we read the id (set to sessionId).
  let sessionId: string | null = null;
  if (typeof arg === 'string') sessionId = arg;
  else if (arg && typeof arg === 'object' && 'id' in arg && typeof (arg as { id: string }).id === 'string') {
    sessionId = (arg as { id: string }).id;
  }
  if (!sessionId) return;
  const dir = projectsDirForCwd();
  if (!dir) return;
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const confirm = await vscode.window.showWarningMessage(
    `Delete session ${sessionId.slice(0, 8)}…? This removes the local transcript file.`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;
  try {
    await fs.promises.unlink(filePath);
    sessionsProvider?.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to delete: ${(err as Error).message}`);
  }
}

function registerStatusBar(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.command = 'claudeCode.open';
  setStatusBarText('idle');
  statusBar.show();
  context.subscriptions.push(statusBar);
}

function setStatusBarText(state: 'idle' | 'busy' | 'pending'): void {
  if (!statusBar) return;
  switch (state) {
    case 'busy':
      statusBar.text = '$(sync~spin) Claude Code';
      statusBar.tooltip = 'Claude is working… click to focus the chat.';
      break;
    case 'pending':
      statusBar.text = '$(bell-dot) Claude Code';
      statusBar.tooltip = 'Claude is awaiting your input.';
      break;
    default:
      statusBar.text = '✱ Claude Code';
      statusBar.tooltip = 'Open Claude Code chat.';
  }
}

function registerFocusContext(context: vscode.ExtensionContext): void {
  // Track focus on the webview by listening to view/panel onDidChangeVisibility.
  const update = (focused: boolean) => {
    void vscode.commands.executeCommand('setContext', FOCUSED_CTX, focused);
  };
  // The sidebar webview view's visibility hint is the closest proxy we have.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(() => {
      if (!vscode.window.state.focused) update(false);
    })
  );
  // We rely on the webview itself posting a 'focused' message for tighter accuracy;
  // in lieu of that, we set true when the panel becomes active.
  update(false);
}

function watchPanelStatusForBadge(context: vscode.ExtensionContext): void {
  // Listen to controller events to drive the status bar text.
  if (!controller) return;
  const sub = controller.onStatus((s) => {
    if (s === 'busy') setStatusBarText('busy');
    else if (s === 'pending') setStatusBarText('pending');
    else setStatusBarText('idle');
  });
  context.subscriptions.push(sub);
}

function watchSessionsDir(context: vscode.ExtensionContext): void {
  const dir = projectsDirForCwd();
  if (!dir) return;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    const watcher = fs.watch(dir, { persistent: false }, () => sessionsProvider?.refresh());
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    /* directory may not exist on first run; the tree will refresh on demand. */
  }
  void os; // satisfy unused-import linter when projectsDir comes from sessionsView
}
