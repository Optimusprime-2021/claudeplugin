import * as vscode from 'vscode';
import { ChatController } from './chatController';
import { getChatHtml } from './webviewContent';

/** Editor-area panel (one shared instance). */
export class ChatPanel {
  public static readonly viewType = 'claudeCodePanel';
  private static instance: ChatPanel | undefined;

  static createOrShow(context: vscode.ExtensionContext, controller: ChatController): ChatPanel {
    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal(vscode.ViewColumn.Active, false);
      return ChatPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'Claude Code',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      }
    );
    ChatPanel.instance = new ChatPanel(context, controller, panel);
    return ChatPanel.instance;
  }

  private readonly detach: vscode.Disposable;

  private constructor(
    context: vscode.ExtensionContext,
    controller: ChatController,
    private readonly panel: vscode.WebviewPanel
  ) {
    panel.webview.html = getChatHtml(panel.webview, context.extensionUri);
    this.detach = controller.attach(panel.webview);

    panel.onDidDispose(() => {
      this.detach.dispose();
      if (ChatPanel.instance === this) ChatPanel.instance = undefined;
    });
  }

  focusInput(): void {
    void this.panel.webview.postMessage({ type: 'focus-input' });
  }
}
