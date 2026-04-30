import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Claude Code');
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string, ...args: unknown[]): void {
    getOutputChannel().appendLine(`[${ts()}] [info] ${format(msg, args)}`);
  },
  warn(msg: string, ...args: unknown[]): void {
    getOutputChannel().appendLine(`[${ts()}] [warn] ${format(msg, args)}`);
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err ? String(err) : '';
    getOutputChannel().appendLine(`[${ts()}] [error] ${msg}${detail ? ` :: ${detail}` : ''}`);
  },
  show(): void {
    getOutputChannel().show(true);
  },
};

function format(msg: string, args: unknown[]): string {
  if (!args.length) return msg;
  return `${msg} ${args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
