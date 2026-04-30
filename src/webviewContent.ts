import * as vscode from 'vscode';

/** Crypto-style nonce for CSP. */
function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'styles.css'));
  const cspSource = webview.cspSource;
  const n = nonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${cspSource} 'unsafe-inline';
             font-src ${cspSource};
             img-src ${cspSource} https: data:;
             script-src 'nonce-${n}';
             connect-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Claude Code</title>
</head>
<body>
  <header class="header">
    <div class="header-title">
      <span class="logo">✶</span>
      <span class="title-text">Claude Code</span>
    </div>
    <div class="header-actions">
      <button class="icon-btn" id="btn-new" title="New conversation (clears history)">
        <span class="icon">＋</span>
      </button>
      <button class="icon-btn" id="btn-resume" title="Resume conversation by ID">
        <span class="icon">↻</span>
      </button>
      <button class="icon-btn" id="btn-settings" title="Settings">
        <span class="icon">⚙</span>
      </button>
    </div>
  </header>

  <div class="plan-banner" id="plan-banner" hidden>
    <span class="plan-icon">◇</span>
    <span>Plan mode — Claude will draft a plan instead of running tools.</span>
  </div>

  <main id="messages" class="messages" aria-live="polite">
    <div class="empty" id="empty-state">
      <div class="empty-logo">✶</div>
      <h1>Welcome to Claude Code</h1>
      <p class="empty-sub">Ask Claude to build, edit, or explain code in your workspace.</p>
      <div class="empty-cards">
        <button class="prompt-card" data-prompt="Explain the structure of this project">
          <div class="prompt-card-title">Explain this project</div>
          <div class="prompt-card-sub">Walk me through the structure and key files</div>
        </button>
        <button class="prompt-card" data-prompt="Find and fix bugs in the code I've selected">
          <div class="prompt-card-title">Fix a bug</div>
          <div class="prompt-card-sub">Investigate and patch issues you find</div>
        </button>
        <button class="prompt-card" data-prompt="Add tests for the file I have open">
          <div class="prompt-card-title">Write tests</div>
          <div class="prompt-card-sub">Cover the file I'm currently working on</div>
        </button>
        <button class="prompt-card" data-prompt="Refactor this code for clarity">
          <div class="prompt-card-title">Refactor</div>
          <div class="prompt-card-sub">Clean up code without changing behavior</div>
        </button>
      </div>
      <div class="empty-tips">
        <kbd>@</kbd> mention files · <kbd>/</kbd> slash commands · <kbd>Esc</kbd> to interrupt
      </div>
    </div>
  </main>

  <footer class="composer">
    <div class="status-row">
      <div class="status" id="status">Ready</div>
      <div class="result-meta-inline" id="result-meta-inline"></div>
    </div>
    <div class="input-shell">
      <div class="input-row">
        <textarea id="input" rows="1" placeholder="Ask Claude — type @ to add a file, / for commands…" spellcheck="false"></textarea>
      </div>
      <div class="input-actions">
        <div class="input-controls">
          <select class="model-select" id="model-select" title="Model">
            <option value="default">default</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
            <option value="haiku">haiku</option>
          </select>
          <select class="mode-select" id="mode-select" title="Permission mode">
            <option value="default">default</option>
            <option value="acceptEdits">accept edits</option>
            <option value="plan">plan</option>
            <option value="bypassPermissions">bypass</option>
          </select>
        </div>
        <div class="input-buttons">
          <button id="btn-send" class="send-btn" title="Send (Enter)" disabled>Send</button>
          <button id="btn-stop" class="stop-btn" title="Stop (Esc)" hidden>Stop</button>
        </div>
      </div>
      <div class="popover" id="popover" hidden></div>
    </div>
    <div class="hint" id="hint">Enter to send · Shift+Enter for newline</div>
  </footer>

  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
