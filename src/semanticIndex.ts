import * as vscode from 'vscode';
import crypto from 'crypto';
import { AzureOpenAIClient } from './azureClient';

type StoredEntryV1 = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  emb_b64: string;
  norm: number;
};

type StoredIndexV1 = {
  version: 1;
  model: string;
  dim: number;
  builtAt: number;
  files: Array<{ path: string; mtime: number; size: number; sha1: string }>;
  entries: StoredEntryV1[];
};

type LoadedEntry = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  emb: Float32Array;
  norm: number;
};

export type SemanticHit = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
};

export class SemanticIndex {
  private readonly _client: AzureOpenAIClient;
  private readonly _storageUri: vscode.Uri;
  private _loaded: { index: StoredIndexV1; entries: LoadedEntry[] } | null = null;
  private _buildPromise: Promise<void> | null = null;

  constructor(args: { client: AzureOpenAIClient; storageUri: vscode.Uri }) {
    this._client = args.client;
    this._storageUri = args.storageUri;
  }

  private _indexFileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this._storageUri, 'semantic-index.v1.json');
  }

  private async _ensureStorageDir(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this._storageUri);
    } catch {
      // ignore
    }
  }

  async ensureBuilt(opts?: { force?: boolean; progressTitle?: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration('azureCodex');
    const enabled = config.get<boolean>('semanticIndexEnabled', true);
    if (!enabled) return;

    if (this._buildPromise) return await this._buildPromise;

    const needs = opts?.force || !(await this._hasIndexOnDisk());
    if (!needs) {
      await this._loadFromDiskIfNeeded();
      return;
    }

    const auto = config.get<boolean>('semanticIndexAutoBuild', true);
    if (!auto && !opts?.force) return;

    this._buildPromise = Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: opts?.progressTitle ?? 'Azure Codex: Indexing workspace…' },
        async () => {
          try {
            await this._buildIndex();
          } finally {
            this._buildPromise = null;
          }
        }
      )
    );
    await this._buildPromise;
    return;
  }

  async search(query: string, opts?: { topK?: number; maxChars?: number }): Promise<SemanticHit[]> {
    const config = vscode.workspace.getConfiguration('azureCodex');
    const enabled = config.get<boolean>('semanticIndexEnabled', true);
    if (!enabled) return [];

    // Do not block chat on first-time indexing. Kick it off in the background and return no hits for now.
    if (!this._loaded && !(await this._hasIndexOnDisk())) {
      this.ensureBuilt({ progressTitle: 'Azure Codex: Indexing workspace…' }).catch(() => {});
      return [];
    }

    await this._loadFromDiskIfNeeded();
    if (!this._loaded) return [];

    const topK = Math.max(1, Math.min(50, opts?.topK ?? config.get<number>('semanticTopK', 6)));
    const maxChars = Math.max(1000, opts?.maxChars ?? config.get<number>('semanticMaxChars', 12000));

    const [q] = await this._client.embed([String(query || '').slice(0, 4000)]);
    const qv = Float32Array.from(q);
    const qn = this._norm(qv);
    if (!Number.isFinite(qn) || qn <= 0) return [];

    const scored: Array<{ score: number; e: LoadedEntry }> = [];
    for (const e of this._loaded.entries) {
      const s = this._dot(e.emb, qv) / (e.norm * qn);
      if (Number.isFinite(s)) scored.push({ score: s, e });
    }
    scored.sort((a, b) => b.score - a.score);

    const out: SemanticHit[] = [];
    let used = 0;
    for (const { score, e } of scored.slice(0, topK * 4)) {
      if (used >= maxChars) break;
      const remaining = maxChars - used;
      const text = e.text.length > remaining ? e.text.slice(0, remaining) : e.text;
      out.push({ path: e.path, startLine: e.startLine, endLine: e.endLine, score, text });
      used += text.length;
      if (out.length >= topK) break;
    }
    return out;
  }

  private async _hasIndexOnDisk(): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this._indexFileUri());
      return true;
    } catch {
      return false;
    }
  }

  private async _loadFromDiskIfNeeded(): Promise<void> {
    if (this._loaded) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(this._indexFileUri());
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredIndexV1;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
      const entries: LoadedEntry[] = parsed.entries.map((e) => {
        const emb = this._b64ToF32(e.emb_b64);
        const norm = Number.isFinite(e.norm) && e.norm > 0 ? e.norm : this._norm(emb);
        return { path: e.path, startLine: e.startLine, endLine: e.endLine, text: e.text, emb, norm };
      });
      this._loaded = { index: parsed, entries };
    } catch {
      this._loaded = null;
    }
  }

  private async _buildIndex(): Promise<void> {
    await this._ensureStorageDir();

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;

    const config = vscode.workspace.getConfiguration('azureCodex');
    const chunkMaxChars = Math.max(500, config.get<number>('semanticChunkMaxChars', 2000));
    const maxFiles = Math.max(50, config.get<number>('semanticMaxFiles', 800));
    const maxChunks = Math.max(200, config.get<number>('semanticMaxChunks', 2500));

    const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
    const uris = await vscode.workspace.findFiles('**/*', exclude, 2000);

    const files: Array<{ path: string; uri: vscode.Uri; text: string; sha1: string; mtime: number; size: number }> = [];
    // Parallelize I/O with a small concurrency limit.
    const candidates = uris
      .map((uri) => ({ uri, rel: this._relPath(uri) }))
      .filter((x) => !!x.rel && !x.rel.endsWith('/') && !this._looksSensitive(x.rel));

    const ioConcurrency = 12;
    for (let i = 0; i < candidates.length && files.length < maxFiles; i += ioConcurrency) {
      const batch = candidates.slice(i, i + ioConcurrency);
      const loaded = await Promise.all(
        batch.map(async ({ uri, rel }) => {
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > 400_000) return null;
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            const sha1 = crypto.createHash('sha1').update(text).digest('hex');
            return { path: rel, uri, text, sha1, mtime: stat.mtime, size: stat.size };
          } catch {
            return null;
          }
        })
      );
      for (const f of loaded) {
        if (f) files.push(f);
        if (files.length >= maxFiles) break;
      }
    }

    const chunks: Array<{ path: string; startLine: number; endLine: number; text: string }> = [];
    for (const f of files) {
      const lines = f.text.replace(/\r\n/g, '\n').split('\n');
      let i = 0;
      while (i < lines.length) {
        let chars = 0;
        const start = i;
        while (i < lines.length && chars < chunkMaxChars) {
          chars += lines[i].length + 1;
          i++;
        }
        const end = i;
        const text = lines.slice(start, end).join('\n').trim();
        if (text) chunks.push({ path: f.path, startLine: start + 1, endLine: end, text });
        if (i === start) i++;
        if (chunks.length >= maxChunks) break;
      }
      if (chunks.length >= maxChunks) break;
    }

    const batchSize = 16;
    const storedEntries: StoredEntryV1[] = [];
    let dim = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embs = await this._client.embed(batch.map((c) => c.text.slice(0, 16_000)));
      for (let j = 0; j < batch.length; j++) {
        const emb = Float32Array.from(embs[j] || []);
        if (!dim && emb.length) dim = emb.length;
        if (!emb.length) continue;
        const norm = this._norm(emb);
        storedEntries.push({
          path: batch[j].path,
          startLine: batch[j].startLine,
          endLine: batch[j].endLine,
          text: batch[j].text,
          emb_b64: this._f32ToB64(emb),
          norm
        });
      }
    }

    const index: StoredIndexV1 = {
      version: 1,
      model: this._getEmbeddingsModelName(),
      dim,
      builtAt: Date.now(),
      files: files.map((f) => ({ path: f.path, mtime: f.mtime, size: f.size, sha1: f.sha1 })),
      entries: storedEntries
    };

    await vscode.workspace.fs.writeFile(this._indexFileUri(), Buffer.from(JSON.stringify(index), 'utf8'));
    this._loaded = null;
    await this._loadFromDiskIfNeeded();
  }

  private _getEmbeddingsModelName(): string {
    const config = vscode.workspace.getConfiguration('azureCodex');
    return config.get<string>('embeddingsDeploymentName', '') || config.get<string>('deploymentName', '');
  }

  private _looksSensitive(relPath: string): boolean {
    const p = relPath.toLowerCase();
    return (
      p.endsWith('.env') ||
      p.includes('/.env') ||
      p.includes('id_rsa') ||
      p.endsWith('.pem') ||
      p.endsWith('.key') ||
      p.endsWith('.pfx') ||
      p.endsWith('.p12') ||
      p.includes('/.git/')
    );
  }

  private _relPath(uri: vscode.Uri): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return uri.fsPath;
    const root = folders[0].uri.fsPath.replace(/\/$/, '');
    const full = uri.fsPath;
    if (full.startsWith(root)) return full.slice(root.length).replace(/^\/+/, '') || full;
    return full;
  }

  private _f32ToB64(arr: Float32Array): string {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
  }

  private _b64ToF32(b64: string): Float32Array {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  }

  private _dot(a: Float32Array, b: Float32Array): number {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  private _norm(a: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s);
  }
}
