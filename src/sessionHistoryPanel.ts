import * as vscode from 'vscode';

export type SessionHistoryEntry = {
  id: string;
  at: number;
  action: string;
  files: string[];
  opCount: number;
};

export class SessionHistoryPanel {
  private static _current: SessionHistoryPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _entries: SessionHistoryEntry[] = [];
  private _onRestore: ((id: string) => Promise<void>) | undefined;
  private _onRefresh: (() => Promise<SessionHistoryEntry[]>) | undefined;

  static show(args: {
    extensionUri: vscode.Uri;
    entries: SessionHistoryEntry[];
    onRestore: (id: string) => Promise<void>;
    onRefresh: () => Promise<SessionHistoryEntry[]>;
  }): SessionHistoryPanel {
    if (SessionHistoryPanel._current) {
      SessionHistoryPanel._current._panel.reveal(vscode.ViewColumn.Beside);
      SessionHistoryPanel._current._entries = args.entries;
      SessionHistoryPanel._current._onRestore = args.onRestore;
      SessionHistoryPanel._current._onRefresh = args.onRefresh;
      SessionHistoryPanel._current._postState();
      return SessionHistoryPanel._current;
    }

    const panel = vscode.window.createWebviewPanel(
      'azureCodex.sessionHistory',
      'Azure Codex: Session History',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [args.extensionUri]
      }
    );

    const instance = new SessionHistoryPanel(panel, args.entries, args.onRestore, args.onRefresh);
    SessionHistoryPanel._current = instance;

    panel.onDidDispose(() => {
      if (SessionHistoryPanel._current === instance) SessionHistoryPanel._current = undefined;
    });

    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    entries: SessionHistoryEntry[],
    onRestore: (id: string) => Promise<void>,
    onRefresh: () => Promise<SessionHistoryEntry[]>
  ) {
    this._panel = panel;
    this._entries = entries;
    this._onRestore = onRestore;
    this._onRefresh = onRefresh;

    this._panel.webview.html = this._html();
    this._panel.webview.onDidReceiveMessage(async (msg) => {
      const type = String(msg?.type || '');
      if (type === 'ready') {
        this._postState();
        return;
      }
      if (type === 'refresh') {
        if (this._onRefresh) {
          this._entries = await this._onRefresh();
          this._postState();
        }
        return;
      }
      if (type === 'restore') {
        const id = String(msg?.id || '');
        if (!id || !this._onRestore) return;
        const ok = await vscode.window.showWarningMessage(
          'Restore this snapshot? This reverts the files changed by that action.',
          { modal: true },
          'Restore'
        );
        if (ok !== 'Restore') return;
        await this._onRestore(id);
        if (this._onRefresh) {
          this._entries = await this._onRefresh();
        }
        this._postState();
      }
    });
  }

  private _postState() {
    this._panel.webview.postMessage({ type: 'state', entries: this._entries });
  }

  private _html(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Session History</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .top { display: flex; gap: 8px; align-items: center; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); flex-wrap: wrap; }
    select, button, input { border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 6px; padding: 6px 8px; }
    input[type="search"] { min-width: 220px; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    .wrap { padding: 10px; }
    .row { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 8px; background: var(--vscode-editorWidget-background); }
    .line1 { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .action { font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .files { margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-descriptionForeground); }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
  </style>
</head>
<body>
  <div class="top">
    <label class="hint" for="sort">Sort:</label>
    <select id="sort">
      <option value="date_desc">Date (newest)</option>
      <option value="date_asc">Date (oldest)</option>
      <option value="action">Action</option>
      <option value="file">File</option>
    </select>
    <input id="query" type="search" placeholder="Filter by file/action" />
    <label class="hint" for="from">From:</label>
    <input id="from" type="date" />
    <label class="hint" for="to">To:</label>
    <input id="to" type="date" />
    <button id="clearFilters">Clear Filters</button>
    <button id="refresh">Refresh</button>
  </div>
  <div class="wrap" id="list"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const listEl = document.getElementById('list');
    const sortEl = document.getElementById('sort');
    const queryEl = document.getElementById('query');
    const fromEl = document.getElementById('from');
    const toEl = document.getElementById('to');
    const clearFiltersEl = document.getElementById('clearFilters');
    const refreshEl = document.getElementById('refresh');
    let entries = [];

    function esc(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function filteredItems() {
      const q = String((queryEl && queryEl.value) || '').trim().toLowerCase();
      const fromRaw = String((fromEl && fromEl.value) || '').trim();
      const toRaw = String((toEl && toEl.value) || '').trim();
      const fromTs = fromRaw ? Date.parse(fromRaw + 'T00:00:00') : NaN;
      const toTs = toRaw ? Date.parse(toRaw + 'T23:59:59.999') : NaN;

      return [...entries].filter((e) => {
        const at = Number(e.at || 0);
        if (!Number.isNaN(fromTs) && at < fromTs) return false;
        if (!Number.isNaN(toTs) && at > toTs) return false;
        if (!q) return true;
        const hay = (String(e.action || '') + ' ' + (Array.isArray(e.files) ? e.files.join(' ') : '')).toLowerCase();
        return hay.includes(q);
      });
    }

    function sortedItems() {
      const mode = String(sortEl.value || 'date_desc');
      const arr = filteredItems();
      if (mode === 'date_asc') arr.sort((a,b) => (a.at||0) - (b.at||0));
      else if (mode === 'action') arr.sort((a,b) => String(a.action||'').localeCompare(String(b.action||'')));
      else if (mode === 'file') arr.sort((a,b) => String((a.files||[])[0]||'').localeCompare(String((b.files||[])[0]||'')));
      else arr.sort((a,b) => (b.at||0) - (a.at||0));
      return arr;
    }

    function render() {
      const items = sortedItems();
      if (!items.length) {
        listEl.innerHTML = '<div class="hint">No history snapshots yet.</div>';
        return;
      }
      listEl.innerHTML = '';
      for (const e of items) {
        const row = document.createElement('div');
        row.className = 'row';
        const firstFiles = (e.files || []).slice(0, 5).map(esc).join(', ');
        const more = (e.files || []).length > 5 ? ', …' : '';
        row.innerHTML =
          '<div class="line1">' +
            '<div><div class="action">' + esc(e.action || 'Action') + '</div>' +
            '<div class="meta">' + new Date(e.at || Date.now()).toLocaleString() + ' · ' + Number(e.opCount || 0) + ' ops</div></div>' +
            '<button class="primary" data-id="' + esc(e.id) + '">Restore</button>' +
          '</div>' +
          '<div class="files">' + firstFiles + more + '</div>';
        row.querySelector('button').addEventListener('click', () => {
          vscode.postMessage({ type: 'restore', id: e.id });
        });
        listEl.appendChild(row);
      }
    }

    sortEl.addEventListener('change', render);
    queryEl.addEventListener('input', render);
    fromEl.addEventListener('change', render);
    toEl.addEventListener('change', render);
    clearFiltersEl.addEventListener('click', () => {
      sortEl.value = 'date_desc';
      queryEl.value = '';
      fromEl.value = '';
      toEl.value = '';
      render();
    });
    refreshEl.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'state') {
        entries = Array.isArray(msg.entries) ? msg.entries : [];
        render();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
