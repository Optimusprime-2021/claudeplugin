/**
 * Stream-JSON event types emitted by `claude --output-format stream-json`.
 * These mirror what the CLI emits one-per-line on stdout.
 */
export type StreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | { type: string; [key: string]: unknown };

export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  permissionMode?: string;
  [key: string]: unknown;
}

export interface AssistantEvent {
  type: 'assistant';
  message: {
    id?: string;
    role: 'assistant';
    model?: string;
    content: ContentBlock[];
    stop_reason?: string | null;
    usage?: Usage;
  };
  session_id?: string;
}

export interface UserEvent {
  type: 'user';
  message: {
    role: 'user';
    content: ContentBlock[] | string;
  };
  session_id?: string;
}

export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  session_id: string;
  usage?: Usage;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ChatConfig {
  useCtrlEnterToSend: boolean;
  hideOnboarding: boolean;
  allowDangerouslySkipPermissions: boolean;
  disableLoginPrompt: boolean;
}

/** Messages exchanged between the extension host and the webview. */
export type HostToWebview =
  | { type: 'state'; busy: boolean; sessionId: string | null; cwd: string | null; model: string; permissionMode: string; pendingPermission?: boolean }
  | { type: 'event'; event: StreamEvent }
  | { type: 'error'; message: string }
  | { type: 'cleared' }
  | { type: 'config'; config: ChatConfig }
  | { type: 'mention'; text: string }
  | { type: 'fileSuggestions'; query: string; results: { path: string; relPath: string }[] }
  | { type: 'focus-input' }
  | { type: 'plan'; markdown: string }
  | { type: 'diagnostics'; text: string }
  | { type: 'terminalOutput'; name: string; text: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newConversation' }
  | { type: 'resume'; sessionId?: string }
  | { type: 'continue' }
  | { type: 'setModel'; model: string }
  | { type: 'setPermissionMode'; mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' }
  | { type: 'openDiff'; filePath: string; oldStr: string; newStr: string }
  | { type: 'openFile'; filePath: string }
  | { type: 'applyEdit'; filePath: string; content: string }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'searchFiles'; query: string }
  | { type: 'openSettings' }
  | { type: 'requestDiagnostics' }
  | { type: 'requestTerminalOutput'; name?: string }
  | { type: 'login' }
  | { type: 'logout' }
  | { type: 'usage' }
  | { type: 'compact' }
  | { type: 'mcp' }
  | { type: 'plugins' }
  | { type: 'openWalkthrough' }
  | { type: 'attachFiles'; files: { path: string; name: string }[] };
