import * as path from 'path';

export type FileContextKind = 'text' | 'image';
export type FileContextSource = 'workspace' | 'absolutePath' | 'upload' | 'auto';
export type FileContextTier = 'persistent' | 'conversation' | 'oneTime';

export type FileContextItem = {
  id: string;
  kind: FileContextKind;
  source: FileContextSource;
  tier: FileContextTier;
  name: string;
  path: string; // display path (may be relative or absolute)
  language: string;
  sizeBytes: number;
  tokenCount: number;
  addedAt: number;
  order: number;
  lastUsedMessage: number;
  stalePromptDismissed?: boolean;
  staleSuggestedAtMessage?: number;
  missingOnDisk?: boolean;
  changedOnDisk?: boolean;
  lastKnownMtimeMs?: number;
  isVirtual?: boolean;
  text?: string; // only for kind=text
  dataUrl?: string; // only for kind=image
};

export class FileContextManager {
  private readonly _items: Map<string, FileContextItem> = new Map(); // id -> item
  private _orderSeq = 0;

  list(): FileContextItem[] {
    return Array.from(this._items.values()).sort((a, b) => a.order - b.order);
  }

  listByTier(tier: FileContextTier): FileContextItem[] {
    return this.list().filter((i) => i.tier === tier);
  }

  get(id: string): FileContextItem | undefined {
    return this._items.get(id);
  }

  getByPath(displayPath: string): FileContextItem | undefined {
    for (const item of this._items.values()) {
      if (item.path === displayPath) return item;
    }
    return undefined;
  }

  remove(id: string): boolean {
    return this._items.delete(id);
  }

  removeByTier(tier: FileContextTier): number {
    const ids = this.listByTier(tier).map((i) => i.id);
    for (const id of ids) this._items.delete(id);
    return ids.length;
  }

  clearConversationScoped() {
    this.removeByTier('conversation');
    this.removeByTier('oneTime');
  }

  clear() {
    this._items.clear();
  }

  setTier(id: string, tier: FileContextTier): boolean {
    const item = this._items.get(id);
    if (!item) return false;
    item.tier = tier;
    item.order = ++this._orderSeq;
    return true;
  }

  markUsed(ids: string[], messageNumber: number) {
    for (const id of ids) {
      const item = this._items.get(id);
      if (!item) continue;
      item.lastUsedMessage = Math.max(item.lastUsedMessage || 0, messageNumber);
      item.order = ++this._orderSeq;
      item.staleSuggestedAtMessage = undefined;
    }
  }

  dismissStalePrompt(id: string): boolean {
    const item = this._items.get(id);
    if (!item) return false;
    item.stalePromptDismissed = true;
    return true;
  }

  reorderWithinTier(tier: FileContextTier, orderedIds: string[]) {
    const current = this.listByTier(tier);
    const index = new Map(orderedIds.map((id, i) => [id, i]));
    const sorted = [...current].sort((a, b) => {
      const ia = index.has(a.id) ? (index.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
      const ib = index.has(b.id) ? (index.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a.order - b.order;
    });
    for (const item of sorted) {
      item.order = ++this._orderSeq;
    }
  }

  removeOneTimeAfterUse(messageNumber: number): FileContextItem[] {
    const removed: FileContextItem[] = [];
    for (const item of this._items.values()) {
      if (item.tier !== 'oneTime') continue;
      if ((item.lastUsedMessage || 0) < messageNumber) continue;
      removed.push(item);
    }
    for (const item of removed) this._items.delete(item.id);
    return removed;
  }

  upsertText(args: {
    id?: string;
    source: FileContextSource;
    displayPath: string;
    sizeBytes: number;
    text: string;
    tier?: FileContextTier;
    tokenCount?: number;
    lastKnownMtimeMs?: number;
    isVirtual?: boolean;
  }) {
    const id = args.id ?? args.displayPath;
    const name = path.basename(args.displayPath);
    const language = languageFromPath(args.displayPath);
    const prev = this._items.get(id);
    this._items.set(id, {
      id,
      kind: 'text',
      source: args.source,
      tier: args.tier || prev?.tier || 'conversation',
      name,
      path: args.displayPath,
      language,
      sizeBytes: args.sizeBytes,
      tokenCount: Math.max(0, Number(args.tokenCount || prev?.tokenCount || 0)),
      addedAt: Date.now(),
      order: ++this._orderSeq,
      lastUsedMessage: prev?.lastUsedMessage || 0,
      stalePromptDismissed: prev?.stalePromptDismissed,
      staleSuggestedAtMessage: prev?.staleSuggestedAtMessage,
      missingOnDisk: prev?.missingOnDisk,
      changedOnDisk: prev?.changedOnDisk,
      lastKnownMtimeMs: Number(args.lastKnownMtimeMs ?? prev?.lastKnownMtimeMs ?? 0) || undefined,
      isVirtual: !!args.isVirtual,
      text: args.text
    });
  }

  upsertImage(args: {
    id?: string;
    source: FileContextSource;
    displayPath: string;
    sizeBytes: number;
    dataUrl: string;
    tier?: FileContextTier;
    tokenCount?: number;
    lastKnownMtimeMs?: number;
  }) {
    const id = args.id ?? args.displayPath;
    const name = path.basename(args.displayPath);
    const language = languageFromPath(args.displayPath);
    const prev = this._items.get(id);
    this._items.set(id, {
      id,
      kind: 'image',
      source: args.source,
      tier: args.tier || prev?.tier || 'conversation',
      name,
      path: args.displayPath,
      language,
      sizeBytes: args.sizeBytes,
      tokenCount: Math.max(0, Number(args.tokenCount || prev?.tokenCount || 0)),
      addedAt: Date.now(),
      order: ++this._orderSeq,
      lastUsedMessage: prev?.lastUsedMessage || 0,
      stalePromptDismissed: prev?.stalePromptDismissed,
      staleSuggestedAtMessage: prev?.staleSuggestedAtMessage,
      missingOnDisk: prev?.missingOnDisk,
      changedOnDisk: prev?.changedOnDisk,
      lastKnownMtimeMs: Number(args.lastKnownMtimeMs ?? prev?.lastKnownMtimeMs ?? 0) || undefined,
      dataUrl: args.dataUrl
    });
  }
}

export function languageFromPath(filePath: string): string {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    sh: 'shell',
    ps1: 'powershell',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    html: 'html',
    css: 'css',
    xml: 'xml',
    txt: 'text',
    pdf: 'pdf',
    csv: 'csv',
    xlsx: 'excel',
    xls: 'excel',
    docx: 'docx',
    pptx: 'pptx',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    webp: 'image',
    gif: 'image'
  };
  return map[ext] || 'text';
}

