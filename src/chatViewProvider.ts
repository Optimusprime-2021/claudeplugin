import * as vscode from 'vscode';
import { ChatController } from './chatController';
import { getChatHtml } from './webviewContent';

/** Sidebar (WebviewView) provider. Persists across reloads as VS Code re-resolves it. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCode.chatView';
  public view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ChatController
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = getChatHtml(view.webview, this.context.extensionUri);

    const detach = this.controller.attach(view.webview);
    view.onDidDispose(() => {
      detach.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  focusInput(): void {
    void this.view?.webview.postMessage({ type: 'focus-input' });
  }
}
