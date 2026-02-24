import * as vscode from 'vscode';

export type StagedFileChange = {
  path: string;
  uri: vscode.Uri;
  prevExists: boolean;
  prevContent: string;
  nextContent: string;
};

export type AgentCheckpoint = {
  step: number;
  at: number;
  label: string;
  // Snapshot of next content per path at this checkpoint
  nextByPath: Record<string, string>;
};

export class AgentSession {
  private readonly _rootUri: vscode.Uri;
  private readonly _staged = new Map<string, StagedFileChange>();
  private readonly _checkpoints: AgentCheckpoint[] = [];
  private _step = 0;

  constructor(rootUri: vscode.Uri) {
    this._rootUri = rootUri;
  }

  get step(): number {
    return this._step;
  }

  listStaged(): StagedFileChange[] {
    return Array.from(this._staged.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  listCheckpoints(): AgentCheckpoint[] {
    return [...this._checkpoints].sort((a, b) => a.step - b.step);
  }

  beginStep(label: string) {
    this._step++;
    const snap: Record<string, string> = {};
    for (const [p, c] of this._staged.entries()) snap[p] = c.nextContent;
    this._checkpoints.push({ step: this._step, at: Date.now(), label, nextByPath: snap });
    if (this._checkpoints.length > 50) this._checkpoints.shift();
  }

  revertToStep(step: number) {
    const cp = [...this._checkpoints].reverse().find((c) => c.step === step);
    if (!cp) return;
    // Remove staged not in snapshot
    for (const p of Array.from(this._staged.keys())) {
      if (!(p in cp.nextByPath)) this._staged.delete(p);
    }
    for (const [p, c] of this._staged.entries()) {
      if (p in cp.nextByPath) c.nextContent = cp.nextByPath[p];
    }
    // Trim checkpoints after step
    while (this._checkpoints.length && this._checkpoints[this._checkpoints.length - 1].step > step) {
      this._checkpoints.pop();
    }
    this._step = step;
  }

  discardAll() {
    this._staged.clear();
  }

  async readFile(path: string, maxChars: number): Promise<string | null> {
    const p = this._normalizeRelPath(path);
    if (!p) return null;
    const staged = this._staged.get(p);
    if (staged) return staged.nextContent.slice(0, maxChars);

    const uri = vscode.Uri.joinPath(this._rootUri, p);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      return text.slice(0, maxChars);
    } catch {
      return null;
    }
  }

  async stageWrite(path: string, nextContent: string) {
    const p = this._normalizeRelPath(path);
    if (!p) throw new Error('Invalid path.');

    const existing = this._staged.get(p);
    if (existing) {
      existing.nextContent = nextContent;
      return;
    }

    const uri = vscode.Uri.joinPath(this._rootUri, p);
    let prevExists = false;
    let prevContent = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      prevExists = true;
      prevContent = Buffer.from(bytes).toString('utf8');
    } catch {
      prevExists = false;
      prevContent = '';
    }

    this._staged.set(p, { path: p, uri, prevExists, prevContent, nextContent });
  }

  private _normalizeRelPath(raw: string): string | null {
    const p = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!p) return null;
    if (p.startsWith('/') || p.startsWith('~') || p.startsWith('..') || p.includes('\\') || p.includes(':')) return null;
    return p;
  }
}

