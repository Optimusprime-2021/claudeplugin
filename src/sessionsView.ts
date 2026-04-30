import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

interface SessionEntry {
  sessionId: string;
  filePath: string;
  title: string;
  mtime: number;
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionEntry> {
  private readonly _onDidChange = new vscode.EventEmitter<SessionEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(entry: SessionEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
    item.id = entry.sessionId;
    item.description = relativeAge(entry.mtime);
    item.tooltip = `${entry.title}\n${entry.sessionId}\n${entry.filePath}`;
    item.contextValue = 'session';
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.command = {
      command: 'claudeCode.openSession',
      title: 'Open',
      arguments: [entry.sessionId],
    };
    return item;
  }

  async getChildren(): Promise<SessionEntry[]> {
    const dir = projectsDirForCwd();
    if (!dir) return [];
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    const out: SessionEntry[] = [];
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        const sessionId = name.replace(/\.jsonl$/, '');
        const title = await readSessionTitle(filePath);
        out.push({ sessionId, filePath, title: title || sessionId.slice(0, 8), mtime: stat.mtimeMs });
      } catch {
        // skip
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, 100);
  }
}

export function projectsDirForCwd(): string | null {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return null;
  // Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/<session>.jsonl.
  // The encoding scheme replaces /, \, : and other separators with '-'. We probe both
  // the documented form and a hashed fallback so this works even if upstream changes.
  const home = os.homedir();
  const encoded = cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  const candidates = [
    path.join(home, '.claude', 'projects', encoded),
    path.join(home, '.claude', 'projects', '-' + encoded),
    path.join(home, '.claude', 'projects', crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 12)),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
}

async function readSessionTitle(filePath: string): Promise<string | null> {
  try {
    const data = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    const firstLine = data.split('\n').find((l) => l.trim().length > 0);
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine);
    if (obj && typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim();
    if (obj && obj.message && typeof obj.message.content === 'string') {
      return truncate(obj.message.content, 64);
    }
    if (obj && Array.isArray(obj.message?.content)) {
      const t = obj.message.content.find((c: { type?: string; text?: string }) => c.type === 'text' && c.text);
      if (t && typeof t.text === 'string') return truncate(t.text, 64);
    }
  } catch {
    /* fall through */
  }
  return null;
}

function relativeAge(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n) + '…';
}
