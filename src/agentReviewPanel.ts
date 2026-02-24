import * as vscode from 'vscode';
import type { AgentSession } from './agentSession';
import { unifiedDiff } from './diffUtil';

type ReviewFile = {
  path: string;
  added: number;
  removed: number;
  diff: string;
  accepted: boolean;
};

export class AgentReviewPanel {
  private static _current: AgentReviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _extensionUri: vscode.Uri;
  private _files: ReviewFile[] = [];
  private _applyCb: ((acceptedPaths: string[]) => Promise<void>) | null = null;
  private _discardCb: (() => void) | null = null;

  static show(args: {
    extensionUri: vscode.Uri;
    title: string;
    session: AgentSession;
    onApply: (acceptedPaths: string[]) => Promise<void>;
    onDiscard: () => void;
  }): AgentReviewPanel {
    if (AgentReviewPanel._current) {
      AgentReviewPanel._current._panel.reveal(vscode.ViewColumn.Beside);
      AgentReviewPanel._current._extensionUri = args.extensionUri;
      AgentReviewPanel._current._applyCb = args.onApply;
      AgentReviewPanel._current._discardCb = args.onDiscard;
      AgentReviewPanel._current._setSession(args.session);
      return AgentReviewPanel._current;
    }

    const panel = vscode.window.createWebviewPanel(
      'azureCodex.agentReview',
      args.title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [args.extensionUri]
      }
    );

    const inst = new AgentReviewPanel(panel, args.extensionUri);
    inst._applyCb = args.onApply;
    inst._discardCb = args.onDiscard;
    inst._setSession(args.session);
    AgentReviewPanel._current = inst;

    panel.onDidDispose(() => {
      if (AgentReviewPanel._current === inst) AgentReviewPanel._current = undefined;
    });

    return inst;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.webview.html = this._html();
    this._panel.webview.onDidReceiveMessage(async (msg) => {
      const type = String(msg?.type || '');
      if (type === 'ready') {
        this._postState();
        return;
      }
      if (type === 'acceptAll') {
        this._files = this._files.map((f) => ({ ...f, accepted: true }));
        this._postState();
        return;
      }
      if (type === 'rejectAll') {
        this._files = this._files.map((f) => ({ ...f, accepted: false }));
        this._postState();
        return;
      }
      if (type === 'toggleFile') {
        const p = String(msg?.path || '');
        this._files = this._files.map((f) => (f.path === p ? { ...f, accepted: !f.accepted } : f));
        this._postState();
        return;
      }
      if (type === 'apply') {
        const accepted = this._files.filter((f) => f.accepted).map((f) => f.path);
        if (!accepted.length) {
          vscode.window.showWarningMessage('No files selected to apply.');
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Apply ${accepted.length} accepted change(s) to disk?`,
          { modal: true },
          'Apply'
        );
        if (confirm !== 'Apply') return;
        await this._applyCb?.(accepted);
        this._panel.dispose();
        return;
      }
      if (type === 'discard') {
        const confirm = await vscode.window.showWarningMessage(
          'Discard all staged changes?',
          { modal: true },
          'Discard'
        );
        if (confirm !== 'Discard') return;
        this._discardCb?.();
        this._panel.dispose();
        return;
      }
      if (type === 'copyDiff') {
        const diff = String(msg?.diff || '');
        await vscode.env.clipboard.writeText(diff);
        vscode.window.showInformationMessage('Copied diff to clipboard.');
        return;
      }
    });
  }

  private _setSession(session: AgentSession) {
    const staged = session.listStaged();
    this._files = staged.map((c) => {
      const d = unifiedDiff(c.prevContent, c.nextContent, c.path);
      return { path: c.path, added: d.added, removed: d.removed, diff: d.text, accepted: true };
    });
    this._postState();
  }

  private _postState() {
    const combined = this._files
      .filter((f) => f.accepted)
      .map((f) => f.diff)
      .join('\n\n');
    this._panel.webview.postMessage({
      type: 'state',
      files: this._files,
      combined
    });
  }

  private _html(): string {
    const nonce = String(Math.random()).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .wrap { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
    .side { border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); overflow: auto; }
    .main { overflow: auto; }
    .topbar { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); position: sticky; top: 0; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
    .list { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .item { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; background: var(--vscode-textBlockQuote-background); cursor: pointer; }
    .item .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .path { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .counts { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .badge { font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); }
    .badge.on { background: rgba(0, 255, 0, 0.08); }
    .badge.off { background: rgba(255, 0, 0, 0.08); }
    pre { margin: 0; padding: 12px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; white-space: pre; }
    .diff-line.add { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .diff-line.del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .diff-line.hunk { color: var(--vscode-textLink-foreground); }
    .diff-line.meta { color: var(--vscode-descriptionForeground); }
    .main-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); }
    .title { font-weight: 600; }
  </style>
  <title>Agent Review</title>
</head>
<body>
  <div class="wrap">
    <div class="side">
      <div class="topbar">
        <button id="acceptAll">Accept All</button>
        <button id="rejectAll" class="secondary">Reject All</button>
      </div>
      <div class="list" id="fileList"></div>
    </div>
    <div class="main">
      <div class="main-head">
        <div class="title">Unified Diff (accepted files)</div>
        <div style="display:flex;gap:8px">
          <button id="copyDiff" class="secondary">Copy Diff</button>
          <button id="discard" class="danger">Reject All</button>
          <button id="apply">Apply Accepted</button>
        </div>
      </div>
      <pre id="diff"></pre>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const listEl = document.getElementById('fileList');
    const diffEl = document.getElementById('diff');
    const acceptAll = document.getElementById('acceptAll');
    const rejectAll = document.getElementById('rejectAll');
    const applyBtn = document.getElementById('apply');
    const discardBtn = document.getElementById('discard');
    const copyBtn = document.getElementById('copyDiff');

    let lastCombined = '';

    acceptAll.addEventListener('click', () => vscode.postMessage({ type: 'acceptAll' }));
    rejectAll.addEventListener('click', () => vscode.postMessage({ type: 'rejectAll' }));
    applyBtn.addEventListener('click', () => vscode.postMessage({ type: 'apply' }));
    discardBtn.addEventListener('click', () => vscode.postMessage({ type: 'discard' }));
    copyBtn.addEventListener('click', () => vscode.postMessage({ type: 'copyDiff', diff: lastCombined }));

    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function renderDiff(text) {
      lastCombined = text || '';
      const lines = String(text || '').split('\\n');
      const html = lines.map((l) => {
        let cls = 'meta';
        if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git')) cls = 'meta';
        else if (l.startsWith('@@')) cls = 'hunk';
        else if (l.startsWith('+') && !l.startsWith('+++')) cls = 'add';
        else if (l.startsWith('-') && !l.startsWith('---')) cls = 'del';
        return '<div class="diff-line ' + cls + '">' + esc(l) + '</div>';
      }).join('');
      diffEl.innerHTML = html;
    }

    function renderFiles(files) {
      listEl.innerHTML = '';
      (files || []).forEach((f) => {
        const el = document.createElement('div');
        el.className = 'item';
        const badgeClass = f.accepted ? 'on' : 'off';
        el.innerHTML =
          '<div class="row"><div class="path">' + esc(f.path) + '</div>' +
          '<div class="badge ' + badgeClass + '">' + (f.accepted ? 'Accepted' : 'Rejected') + '</div></div>' +
          '<div class="row"><div class="counts">+' + (f.added||0) + '  -' + (f.removed||0) + '</div>' +
          '<button class="secondary" style="padding:2px 8px">Toggle</button></div>';
        el.querySelector('button').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'toggleFile', path: f.path });
        });
        el.addEventListener('click', () => {
          // Clicking file copies its diff into the main pane (still "combined accepted" view).
          renderDiff((files || []).filter(x => x.path === f.path).map(x => x.diff).join('\\n\\n'));
        });
        listEl.appendChild(el);
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        renderFiles(msg.files);
        renderDiff(msg.combined);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
