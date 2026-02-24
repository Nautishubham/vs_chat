import * as vscode from 'vscode';

export type MemoryItem = { key: string; value: string; at: number };

export class MemoryStore {
  private readonly _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  private _storageKey(workspaceId: string): string {
    return `azureCodex.memory.${workspaceId}`;
  }

  private _workspaceId(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return 'no-workspace';
    return folders.map((f) => f.uri.fsPath).join('|');
  }

  private _getItems(): MemoryItem[] {
    const id = this._workspaceId();
    const raw = this._context.globalState.get<MemoryItem[]>(this._storageKey(id), []);
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.key === 'string' && typeof x.value === 'string') : [];
  }

  private async _setItems(items: MemoryItem[]): Promise<void> {
    const id = this._workspaceId();
    await this._context.globalState.update(this._storageKey(id), items);
  }

  list(): MemoryItem[] {
    return this._getItems().sort((a, b) => b.at - a.at);
  }

  async remember(key: string, value: string): Promise<void> {
    const k = String(key || '').trim();
    const v = String(value || '').trim();
    if (!k || !v) return;

    const items = this._getItems();
    const now = Date.now();
    const filtered = items.filter((i) => i.key !== k);
    filtered.unshift({ key: k, value: v, at: now });

    const config = vscode.workspace.getConfiguration('azureCodex');
    const maxItems = Math.max(5, config.get<number>('memoryMaxItems', 50));
    await this._setItems(filtered.slice(0, maxItems));
  }

  async forget(key: string): Promise<void> {
    const k = String(key || '').trim();
    if (!k) return;
    const items = this._getItems().filter((i) => i.key !== k);
    await this._setItems(items);
  }

  async clear(): Promise<void> {
    await this._setItems([]);
  }

  buildContext(maxChars: number): string {
    const config = vscode.workspace.getConfiguration('azureCodex');
    const enabled = config.get<boolean>('memoryEnabled', true);
    if (!enabled) return '';

    const items = this.list();
    if (!items.length) return '';

    const lines: string[] = ['Project memory (persistent preferences):'];
    for (const i of items) {
      lines.push(`- ${i.key}: ${i.value}`);
    }

    const text = lines.join('\n');
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n[truncated]';
  }
}

