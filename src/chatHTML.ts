export function getChatHTML(): string {
  // Single-file webview (no bundler) with a responsive 3-panel layout.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Azure Codex Chat</title>
    <style>
      :root {
        --bg: var(--vscode-editor-background);
        --panel: var(--vscode-sideBar-background);
        --panel2: var(--vscode-editorGroupHeader-tabsBackground);
        --border: var(--vscode-panel-border);
        --muted: var(--vscode-descriptionForeground);
        --fg: var(--vscode-foreground);
        --focus: var(--vscode-focusBorder);
        --input: var(--vscode-input-background);
        --hover: var(--vscode-toolbar-hoverBackground);
        --agent-bg: #1e1e1e;
        --agent-border: rgba(255,255,255,0.08);
        --agent-blue: #3b82f6;
        --agent-green: #22c55e;
        --agent-red: #ef4444;
        --agent-yellow: #f59e0b;
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        line-height: 1.45;
        letter-spacing: 0.01em;
        color: var(--fg);
        background: var(--bg);
        overflow: hidden;
      }

      /* Layout */
      #app {
        height: 100vh;
        display: grid;
        grid-template-columns: 260px 1fr 320px;
        border-top: 1px solid var(--border);
        min-height: 0; /* allow scroll containers inside grid */
      }
      .panel {
        min-width: 0;
        min-height: 0; /* allow scroll containers inside flex panels */
        border-right: 1px solid var(--border);
        background: var(--panel);
        display: flex;
        flex-direction: column;
      }
      #right { border-right: none; border-left: 1px solid var(--border); }
      #center {
        min-width: 0;
        min-height: 0; /* critical for #messages scrolling */
        display: flex;
        flex-direction: column;
        background: var(--bg);
      }

      /* Headers */
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 9px;
        background: var(--panel2);
        border-bottom: 1px solid var(--border);
        flex: 0 0 auto;
      }
      .panel-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted);
      }
      .icon-row { display: flex; gap: 6px; align-items: center; }
      .icon-btn {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--fg);
        border-radius: 6px;
        padding: 5px 8px;
        cursor: pointer;
        font-size: 12px;
        opacity: 0.85;
      }
      .icon-btn:hover { background: var(--hover); opacity: 1; }
      .icon-btn:disabled { opacity: 0.4; cursor: default; }
      .continue-pill {
        padding: 3px 8px;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.2;
        color: var(--fg);
        background: color-mix(in srgb, var(--panel2) 88%, transparent);
      }
      .continue-pill.ok {
        border-color: color-mix(in srgb, var(--agent-green) 55%, var(--border));
        color: var(--agent-green);
      }
      .continue-pill.warn {
        border-color: color-mix(in srgb, var(--agent-yellow) 55%, var(--border));
        color: var(--agent-yellow);
      }
      .continue-pill.danger {
        border-color: color-mix(in srgb, var(--agent-red) 55%, var(--border));
        color: var(--agent-red);
      }

      .section { padding: 8px; border-bottom: 1px solid var(--border); }
      .section h4 { margin: 0 0 8px; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
      .hint { color: var(--muted); font-size: 10px; line-height: 1.45; }

      /* Lists */
      .list { display: flex; flex-direction: column; gap: 5px; }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 6px 7px;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: color-mix(in srgb, var(--panel) 85%, transparent);
      }
      .row:hover { background: var(--hover); }
      .row.dragging { opacity: 0.6; border-style: dashed; }
      .row.drag-over { border-color: var(--focus); }
      .row .left {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .row .title { font-size: 11px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row .meta { font-size: 10px; color: var(--muted); line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row .actions { display: flex; gap: 6px; }
      .mini {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--fg);
        border-radius: 6px;
        padding: 3px 6px;
        font-size: 11px;
        cursor: pointer;
        opacity: 0.8;
      }
      .mini:hover { background: var(--hover); opacity: 1; }

      .search {
        width: 100%;
        padding: 7px 8px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--input);
        color: var(--fg);
        outline: none;
      }
      .search:focus { border-color: var(--focus); }

      /* Messages */
      #messages {
        flex: 1 1 auto;
        min-height: 0; /* critical in flex layouts */
        overflow: auto;
        padding: 8px 0;
        scroll-behavior: smooth;
        overscroll-behavior: contain;
      }
      #messages::-webkit-scrollbar { width: 8px; }
      #messages::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 6px; }
      .message {
        margin: 6px 10px;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--bg) 88%, var(--panel));
      }
      .message.user {
        background: var(--input);
        border-left: 2px solid var(--focus);
      }
      .message.assistant {
        background: color-mix(in srgb, var(--bg) 92%, var(--panel));
      }
      .msg-label {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: var(--muted);
        margin-bottom: 4px;
      }
      .msg-content { white-space: pre-wrap; word-break: break-word; line-height: 1.5; letter-spacing: 0.005em; }
      .message.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }

      .agent-status {
        margin: 1px 0 7px;
        padding: 6px 8px;
        border: 1px solid var(--agent-border);
        border-radius: 7px;
        background: var(--agent-bg);
        color: var(--muted);
        font-size: 10px;
        letter-spacing: 0.02em;
        line-height: 1.35;
      }

      /* Code blocks */
      .code-block-wrapper { margin: 7px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
      .bulk-review-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 6px 0 8px;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: color-mix(in srgb, var(--panel2) 88%, transparent);
      }
      .bulk-review-meta { font-size: 10px; color: var(--muted); }
      .bulk-review-actions { display: flex; gap: 6px; }
      .code-block-header { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; background: var(--panel2); }
      .code-block-header .lang { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; color: var(--muted); }
      .code-block-actions { display: flex; gap: 6px; }
      .code-btn { background: transparent; border: 1px solid var(--border); color: var(--fg); border-radius: 6px; padding: 2px 7px; font-size: 10px; cursor: pointer; opacity: 0.9; }
      .code-btn:hover { background: var(--hover); }
      .code-btn.active { border-color: var(--focus); color: var(--focus); }
      pre { margin: 0; padding: 12px; background: var(--bg); overflow: auto; }
      code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }

      .diff-rows { font-family: var(--vscode-editor-font-family); font-size: 10px; line-height: 1.35; background: var(--bg); }
      .diff-row {
        display: grid;
        grid-template-columns: 36px 12px 1fr;
        gap: 6px;
        padding: 1px 8px;
        border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
      }
      .diff-row .ln { color: var(--muted); text-align: right; }
      .diff-row .sg { color: var(--muted); text-align: center; }
      .diff-row .tx { white-space: pre; overflow-x: auto; }
      .diff-row.add { background: color-mix(in srgb, var(--agent-green) 16%, transparent); }
      .diff-row.add .sg, .diff-row.add .tx { color: var(--agent-green); }
      .diff-row.del { background: color-mix(in srgb, var(--agent-red) 14%, transparent); }
      .diff-row.del .sg, .diff-row.del .tx { color: var(--agent-red); }
      .diff-split {
        display: none;
        grid-template-columns: 1fr 1fr;
        gap: 0;
        border-top: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
      }
      .diff-split-col {
        border-right: 1px solid color-mix(in srgb, var(--border) 35%, transparent);
      }
      .diff-split-col:last-child { border-right: none; }
      .diff-split-hd {
        font-size: 10px;
        color: var(--muted);
        padding: 4px 8px;
        border-bottom: 1px solid color-mix(in srgb, var(--border) 35%, transparent);
      }
      .diff-split-body { max-height: 360px; overflow: auto; }
      .diff-ctx {
        display: block;
        padding: 2px 8px;
        color: var(--muted);
        font-family: var(--vscode-editor-font-family);
        font-size: 10px;
        border-bottom: 1px dashed color-mix(in srgb, var(--border) 45%, transparent);
      }

      /* Composer */
      #composer {
        flex: 0 0 auto;
        padding: 8px 10px;
        border-top: 1px solid var(--border);
        background: var(--panel2);
      }
      .agent-card {
        border: 1px solid var(--agent-border);
        border-radius: 8px;
        background: var(--agent-bg);
        margin-bottom: 6px;
        overflow: hidden;
      }
      .agent-card-hd {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 8px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted);
        border-bottom: 1px solid var(--agent-border);
      }
      .agent-card-hd button { border: 1px solid var(--agent-border); background: transparent; color: var(--fg); border-radius: 6px; cursor: pointer; }
      .agent-card-bd { padding: 6px; max-height: 150px; overflow: auto; }
      .agent-card.collapsed .agent-card-bd { display: none; }
      .agent-line {
        font-family: var(--vscode-editor-font-family);
        font-size: 10px;
        line-height: 1.4;
        padding: 4px 6px;
        border-radius: 6px;
        color: var(--fg);
        opacity: 0;
        transform: translateY(4px);
        animation: lineIn .24s cubic-bezier(.2,.8,.2,1) forwards;
      }
      .agent-line.warn { color: var(--agent-yellow); }
      .agent-line.ok { color: var(--agent-green); }
      .agent-line.processing { color: var(--muted); }
      .spinner { display: inline-block; animation: spin 1.1s linear infinite; }

      .todo-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; font-size: 11px; line-height: 1.35; }
      .todo-dot { width: 14px; text-align: center; color: var(--muted); }
      .todo-item.active .todo-dot { color: var(--agent-blue); animation: pulse 1.2s ease infinite; }
      .todo-item.done .todo-dot { color: var(--agent-green); }

      @keyframes lineIn { to { opacity: 1; transform: translateY(0); } }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes pulse { 0% { opacity: .4; } 50% { opacity: 1; } 100% { opacity: .4; } }
      #chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 2px 7px;
        background: color-mix(in srgb, var(--panel) 85%, transparent);
        max-width: 100%;
      }
      .chip.auto { border-color: color-mix(in srgb, var(--agent-blue) 55%, var(--border)); }
      .chip code { background: transparent; }
      .chip .x { border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; }
      .chip .x:hover { color: var(--fg); }

      #input-wrap {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--input);
        padding: 8px;
      }
      .composer-tools { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
      .mode-select {
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--panel);
        color: var(--fg);
        font-size: 11px;
        padding: 4px 6px;
      }
      textarea {
        width: 100%;
        resize: none;
        border: none;
        outline: none;
        background: transparent;
        color: var(--fg);
        font-family: inherit;
        line-height: 1.5;
        letter-spacing: 0.005em;
        min-height: 44px;
        max-height: 160px;
      }
      #composer-row { display: flex; align-items: center; justify-content: space-between; gap: 7px; margin-top: 6px; }
      #status { font-size: 10px; line-height: 1.35; color: var(--muted); }
      .send-split { display: inline-flex; border-radius: 7px; overflow: hidden; border: 1px solid var(--border); }
      .send-split .icon-btn { border: none; border-right: 1px solid var(--border); border-radius: 0; }
      .send-split .icon-btn:last-child { border-right: none; width: 30px; padding: 0; }
      #send-menu {
        position: absolute;
        right: 14px;
        bottom: 66px;
        min-width: 150px;
        border: 1px solid var(--border);
        background: var(--panel2);
        border-radius: 8px;
        display: none;
        z-index: 30;
      }
      #send-menu button { width: 100%; text-align: left; padding: 8px; border: none; background: transparent; color: var(--fg); cursor: pointer; }
      #send-menu button:hover { background: var(--hover); }
      #stop.hidden { display: none; }

      #change-summary { display: none; }
      .change-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-size: 10px;
        line-height: 1.35;
      }
      .delta-add { color: var(--agent-green); font-family: var(--vscode-editor-font-family); }
      .delta-del { color: var(--agent-red); font-family: var(--vscode-editor-font-family); }
      .change-files { margin-top: 6px; display: none; font-family: var(--vscode-editor-font-family); font-size: 10px; }
      .change-files.on { display: block; }
      .change-actions { display: flex; gap: 6px; }
      .btn-keep { background: var(--agent-blue); color: white; border: 1px solid var(--agent-blue); border-radius: 7px; padding: 4px 8px; cursor: pointer; }

      /* Progress indicator */
      #progress-container { display: none; margin-top: 8px; }
      #progress-bar {
        width: 100%;
        height: 4px;
        background: var(--panel);
        border-radius: 2px;
        overflow: hidden;
      }
      #progress-bar::after {
        content: '';
        display: block;
        height: 100%;
        background: var(--focus);
        animation: progress 1.8s ease-in-out infinite;
      }
      @keyframes progress {
        0% { width: 0%; }
        50% { width: 70%; }
        100% { width: 100%; }
      }

      /* Right preview */
      #preview {
        flex: 1 1 auto;
        overflow: auto;
        padding: 10px;
        background: var(--bg);
      }
      #preview pre { border: 1px solid var(--border); border-radius: 10px; }
      #preview img { max-width: 100%; border-radius: 10px; border: 1px solid var(--border); }

      /* Drag-drop overlay */
      #drop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.35);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 50;
      }
      #drop.on { display: flex; }
      #drop .card {
        background: var(--panel2);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 16px 18px;
        width: min(520px, calc(100vw - 28px));
      }
      #drop .card h3 { margin: 0 0 6px; font-size: 13px; }
      #drop .card p { margin: 0; color: var(--muted); font-size: 12px; }

      /* Scroll to bottom FAB */
      .scroll-fab {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: var(--panel2);
        border: 1px solid var(--border);
        color: var(--fg);
        font-size: 18px;
        cursor: pointer;
        z-index: 10;
        opacity: 0.9;
        transition: opacity 0.2s;
      }
      .scroll-fab:hover { opacity: 1; }

      /* Responsive: collapse side panels */
      @media (max-width: 900px) {
        #app { grid-template-columns: 1fr; }
        #left, #right { display: none; }
        #center { border-left: none; border-right: none; }
      }
    </style>
  </head>
  <body>
    <div id="app">
      <aside class="panel" id="left">
        <div class="panel-header">
          <div class="panel-title">Chats</div>
          <div class="icon-row">
            <button class="icon-btn" id="new-chat">New</button>
          </div>
        </div>
        <div class="section">
          <div class="list" id="chat-list"></div>
        </div>
        <div class="panel-header">
          <div class="panel-title">Files</div>
          <div class="icon-row">
            <button class="icon-btn" id="refresh-files">Refresh</button>
          </div>
        </div>
        <div class="section">
          <input class="search" id="file-filter" placeholder="Filter files…" />
          <div style="height: 8px"></div>
          <div class="list" id="file-list"></div>
          <div style="height: 8px"></div>
          <div class="hint">Click “Add” to pin a file into the current chat context.</div>
        </div>
      </aside>

      <main id="center">
        <div class="panel-header">
          <div class="panel-title">Azure Codex</div>
          <div class="icon-row">
            <button class="icon-btn" id="new-chat-top">New Chat</button>
            <button class="icon-btn" id="export-chat">Export</button>
            <button class="icon-btn" id="share-session">Share</button>
            <button class="icon-btn" id="load-session">Load</button>
            <button class="icon-btn" id="open-changelog">History</button>
            <button class="icon-btn" id="clear" onclick="try{acquireVsCodeApi().postMessage({type:'clearHistory'})}catch(e){}">Clear</button>
            <button class="icon-btn" id="settings" onclick="try{acquireVsCodeApi().postMessage({type:'openSettings'})}catch(e){}">Settings</button>
          </div>
        </div>

        <div id="messages"></div>

        <div id="composer">
          <div id="action-card" class="agent-card collapsed">
            <div class="agent-card-hd">Agent Activity <button id="toggle-actions">▸</button></div>
            <div class="agent-card-bd" id="action-log"></div>
          </div>
          <div id="todo-card" class="agent-card collapsed">
            <div class="agent-card-hd"><span id="todo-title">Plan (0/0)</span><button id="toggle-todos">▸</button></div>
            <div class="agent-card-bd" id="todo-list"></div>
          </div>
          <div id="change-summary" class="agent-card">
            <div class="agent-card-bd">
              <div class="change-bar">
                <div>
                  <button class="icon-btn" id="toggle-changes">&gt;</button>
                  <span id="change-text"></span>
                </div>
                <div class="change-actions">
                  <button class="btn-keep" id="keep-changes">Keep Changes</button>
                  <button class="icon-btn" id="undo-changes">Rollback</button>
                </div>
              </div>
              <div class="change-files" id="change-files"></div>
            </div>
          </div>
          <div id="chips"></div>
          <div id="input-wrap">
            <div class="composer-tools">
              <button class="icon-btn" id="attach" title="Attach" onclick="try{acquireVsCodeApi().postMessage({type:'pickAttachments'})}catch(e){}">📎</button>
              <select id="mode" class="mode-select">
                <option>Auto</option>
                <option>QnA</option>
                <option>Refactor</option>
                <option>Agent</option>
              </select>
            </div>
            <textarea id="input" placeholder="Describe what you want to build or fix" onkeydown="try{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();var t=this.value.trim();var m=(document.getElementById('mode')&&document.getElementById('mode').value||'Auto').toLowerCase();if(t){acquireVsCodeApi().postMessage({type:'userMessage',text:t,mode:m});this.value='';this.style.height='auto';}}}catch(e){}"></textarea>
            <div id="composer-row">
              <div class="icon-row">
                <button class="icon-btn hidden" id="stop" disabled>⏹ Stop</button>
                <button class="icon-btn hidden" id="continue-btn">▶ Continue</button>
                <span class="continue-pill hidden" id="continue-pill">Auto-continue left: 0</span>
              </div>
              <div id="status"></div>
              <div class="send-split">
                <button class="icon-btn" id="send" onclick="try{var i=document.getElementById('input');var m=(document.getElementById('mode')&&document.getElementById('mode').value||'Auto').toLowerCase();var t=(i&&i.value||'').trim();if(t){acquireVsCodeApi().postMessage({type:'userMessage',text:t,mode:m});i.value='';i.style.height='auto';}}catch(e){}">Send</button>
                <button class="icon-btn" id="send-options">▾</button>
              </div>
            </div>
            <div id="send-menu">
              <button id="send-now" onclick="try{var i=document.getElementById('input');var m=(document.getElementById('mode')&&document.getElementById('mode').value||'Auto').toLowerCase();var t=(i&&i.value||'').trim();if(t){acquireVsCodeApi().postMessage({type:'userMessage',text:t,mode:m});i.value='';i.style.height='auto';}}catch(e){}">Send now</button>
              <button id="send-queue" onclick="try{var i=document.getElementById('input');var m=(document.getElementById('mode')&&document.getElementById('mode').value||'Auto').toLowerCase();var t=(i&&i.value||'').trim();if(t){acquireVsCodeApi().postMessage({type:'userMessage',text:t,mode:m});i.value='';i.style.height='auto';}}catch(e){}">Send after current task</button>
            </div>
          </div>
          <div id="progress-container">
            <div id="progress-bar"></div>
          </div>
          <div class="hint" style="margin-top:8px">Drag & drop files here to attach. Enter sends · Shift+Enter adds a new line.</div>
        </div>
      </main>

      <aside class="panel" id="right">
        <div class="panel-header">
          <div class="panel-title">Context</div>
          <div class="icon-row">
            <button class="icon-btn" id="clear-conversation-context">Clear chat refs</button>
            <button class="icon-btn" id="clear-nonpersistent-context">Clear non-persistent</button>
            <button class="icon-btn" id="undo" disabled>Undo</button>
          </div>
        </div>
        <div class="section">
          <div class="hint" id="ctx-summary">Pinned files are sent automatically.</div>
          <div class="hint" id="changes" style="margin-top:6px"></div>
          <div style="height: 8px"></div>
          <div class="list" id="ctx-list"></div>
        </div>
        <div class="panel-header">
          <div class="panel-title">Preview</div>
          <div class="icon-row">
            <button class="icon-btn" id="open-preview" disabled>Open</button>
          </div>
        </div>
        <div id="preview"><div class="hint">Select a context file to preview.</div></div>
      </aside>
    </div>

    <div id="drop">
      <div class="card">
        <h3>Attach files to context</h3>
        <p>Drop to add. Text/code will be injected into the next prompt; images will be sent as image attachments.</p>
      </div>
    </div>

    <button id="scroll-fab" class="scroll-fab" style="display: none;">↓</button>

    <script>
      (function () {
        if (window.__azureCodexBridgeInstalled) return;
        window.__azureCodexBridgeInstalled = true;

        let vscodeApi = null;
        try {
          if (window.__azureCodexVscodeApi) {
            vscodeApi = window.__azureCodexVscodeApi;
          } else if (typeof acquireVsCodeApi === 'function') {
            vscodeApi = acquireVsCodeApi();
            window.__azureCodexVscodeApi = vscodeApi;
          }
        } catch {
          vscodeApi = null;
        }

        function post(type, payload) {
          if (!vscodeApi || !type) return;
          try {
            vscodeApi.postMessage(Object.assign({ type: type }, payload || {}));
          } catch {
            // ignore
          }
        }

        function sendFromInput() {
          const input = document.getElementById('input');
          const mode = document.getElementById('mode');
          if (!input) return;
          const text = String(input.value || '').trim();
          if (!text) return;
          input.value = '';
          try { input.style.height = 'auto'; } catch {}
          post('userMessage', { text: text, mode: String((mode && mode.value) || 'Auto').toLowerCase() });
        }

        document.addEventListener('click', function (ev) {
          const target = ev && ev.target && ev.target.closest ? ev.target.closest('button') : null;
          if (!target || !target.id) return;
          switch (target.id) {
            case 'send':
            case 'send-now':
            case 'send-queue':
              ev.preventDefault();
              sendFromInput();
              break;
            case 'attach':
              post('pickAttachments');
              break;
            case 'clear':
              post('clearHistory');
              break;
            case 'settings':
              post('openSettings');
              break;
            case 'export-chat':
              post('exportChat');
              break;
            case 'share-session':
              post('shareSession');
              break;
            case 'load-session':
              post('loadSharedSession');
              break;
            case 'open-changelog':
              post('openChangeLog');
              break;
            case 'stop':
              post('stopGeneration');
              break;
            case 'new-chat':
              post('newChat');
              break;
            case 'refresh-files':
              post('getWorkspaceFiles');
              break;
            case 'undo':
            case 'undo-changes':
              post('undoLastApply');
              break;
            default:
              break;
          }
        }, true);

        document.addEventListener('keydown', function (ev) {
          const target = ev && ev.target ? ev.target : null;
          if (!target || target.id !== 'input') return;
          if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            sendFromInput();
          }
        }, true);
      })();
    </script>

    <script>
      const vscode = window.__azureCodexVscodeApi || acquireVsCodeApi();
      window.__azureCodexVscodeApi = vscode;

      const el = (id) => document.getElementById(id);
      const messagesEl = el('messages');
      const chatListEl = el('chat-list');
      const fileListEl = el('file-list');
      const fileFilterEl = el('file-filter');
      const ctxListEl = el('ctx-list');
      const previewEl = el('preview');
      const chipsEl = el('chips');
      const ctxSummaryEl = el('ctx-summary');

      const inputEl = el('input');
      const sendBtn = el('send');
      const stopBtn = el('stop');
      const continueBtn = el('continue-btn');
      const continuePill = el('continue-pill');
      const undoBtn = el('undo');
      const openPreviewBtn = el('open-preview');
      const statusEl = el('status');
      const dropEl = el('drop');
      const scrollFabEl = el('scroll-fab');
      const progressContainerEl = el('progress-container');
      const actionCardEl = el('action-card');
      const todoCardEl = el('todo-card');
      const actionLogEl = el('action-log');
      const todoListEl = el('todo-list');
      const todoTitleEl = el('todo-title');
      const toggleActionsEl = el('toggle-actions');
      const toggleTodosEl = el('toggle-todos');
      const changeSummaryEl = el('change-summary');
      const changeTextEl = el('change-text');
      const changeFilesEl = el('change-files');
      const toggleChangesEl = el('toggle-changes');
      const keepChangesEl = el('keep-changes');
      const undoChangesEl = el('undo-changes');
      const sendOptionsEl = el('send-options');
      const sendMenuEl = el('send-menu');
      const sendNowEl = el('send-now');
      const sendQueueEl = el('send-queue');
      const modeEl = el('mode');

      // Bootstrap critical controls early so they still work even if later UI code throws.
      function postSafe(type, payload) {
        try {
          vscode.postMessage(Object.assign({ type }, payload || {}));
        } catch {
          // ignore
        }
      }
      function bindCritical(id, handler) {
        const node = el(id);
        if (!node || typeof node.addEventListener !== 'function') return;
        try {
          node.addEventListener('click', handler);
        } catch {
          // ignore
        }
      }
      bindCritical('clear', () => postSafe('clearHistory'));
      bindCritical('settings', () => postSafe('openSettings'));
      bindCritical('export-chat', () => postSafe('exportChat'));
      bindCritical('share-session', () => postSafe('shareSession'));
      bindCritical('load-session', () => postSafe('loadSharedSession'));
      bindCritical('open-changelog', () => postSafe('openChangeLog'));
      bindCritical('attach', () => postSafe('pickAttachments'));
      bindCritical('new-chat', () => postSafe('newChat'));
      bindCritical('new-chat-top', () => postSafe('newChat'));
      bindCritical('refresh-files', () => postSafe('getWorkspaceFiles'));
      bindCritical('undo', () => postSafe('undoLastApply'));
      bindCritical('open-preview', () => {
        try {
          if (!lastPreviewItem || !lastPreviewItem.path) return;
          postSafe('openFile', { path: lastPreviewItem.path });
        } catch {
          // ignore
        }
      });
      bindCritical('stop', () => postSafe('stopGeneration'));
      bindCritical('continue-btn', () => {
        postSafe('userMessage', {
          text: continuationSuggestedText,
          mode: String((modeEl && modeEl.value) || 'Auto').toLowerCase()
        });
        const node = el('continue-btn');
        if (node) node.classList.add('hidden');
      });
      bindCritical('send', () => {
        try {
          const txtNode = el('input');
          const text = String((txtNode && txtNode.value) || '').trim();
          if (!text) return;
          txtNode.value = '';
          txtNode.style.height = 'auto';
          postSafe('userMessage', { text, mode: String((modeEl && modeEl.value) || 'Auto').toLowerCase() });
        } catch {
          // ignore
        }
      });

      // Emergency command bridge: keeps core actions functional even if later UI setup throws.
      function bridgeSendFromInput() {
        try {
          const txtNode = el('input');
          const text = String((txtNode && txtNode.value) || '').trim();
          if (!text) return;
          txtNode.value = '';
          txtNode.style.height = 'auto';
          postSafe('userMessage', { text, mode: String((modeEl && modeEl.value) || 'Auto').toLowerCase() });
        } catch {
          // ignore
        }
      }
      on(document, 'click', (ev) => {
        const target = ev && ev.target && ev.target.closest ? ev.target.closest('button') : null;
        if (!target || !target.id) return;
        switch (target.id) {
          case 'clear':
            postSafe('clearHistory');
            break;
          case 'settings':
            postSafe('openSettings');
            break;
          case 'export-chat':
            postSafe('exportChat');
            break;
          case 'share-session':
            postSafe('shareSession');
            break;
          case 'load-session':
            postSafe('loadSharedSession');
            break;
          case 'open-changelog':
            postSafe('openChangeLog');
            break;
          case 'attach':
            postSafe('pickAttachments');
            break;
          case 'send':
          case 'send-now':
          case 'send-queue':
            bridgeSendFromInput();
            break;
          case 'stop':
            postSafe('stopGeneration');
            break;
          case 'new-chat':
          case 'new-chat-top':
            postSafe('newChat');
            break;
          case 'refresh-files':
            postSafe('getWorkspaceFiles');
            break;
          case 'undo':
          case 'undo-changes':
            postSafe('undoLastApply');
            break;
          case 'open-preview': {
            try {
              if (!lastPreviewItem || !lastPreviewItem.path) return;
              postSafe('openFile', { path: lastPreviewItem.path });
            } catch {
              // ignore
            }
            break;
          }
          default:
            break;
        }
      }, true);

      on(document, 'keydown', (ev) => {
        try {
          if (!ev || ev.key !== 'Enter' || ev.shiftKey) return;
          const target = ev.target;
          if (!target || target.id !== 'input') return;
          ev.preventDefault();
          bridgeSendFromInput();
        } catch {
          // ignore
        }
      }, true);

      let isStreaming = false;
      let rawBuffer = '';
      let currentMsgEl = null;
      let currentContentEl = null;
      let currentStatusBarEl = null;

      let state = { chats: [], activeId: null, transcript: [] };
      let workspaceFiles = [];
      let contextStatus = null;
      let undoStatus = { canUndo: false, label: '', paths: [] };
      let lastPreviewItem = null;
      let scrollNearBottomThreshold = 120;
      let autoScrollEnabled = true;
      let agentActions = [];
      let agentTodos = [];
      let latestChangeSummary = null;
      let generatedTokenCount = 0;
      let continuationSuggestedText = 'Continue exactly from where you left off without repeating anything';
      let continuationRemaining = 0;
      let continuationMax = 3;
      let autoApplyArmed = false;

      function classifyScope(totalChangedLines) {
        if (totalChangedLines <= 3) return 'tiny';
        if (totalChangedLines <= 20) return 'small';
        if (totalChangedLines <= 50) return 'medium';
        return 'large';
      }

      function updateContinuationPill() {
        if (!continuePill) return;
        continuePill.textContent = 'Auto-continue left: ' + String(continuationRemaining);
        continuePill.classList.remove('ok', 'warn', 'danger');
        if (continuationRemaining <= 0) {
          continuePill.classList.add('danger');
          return;
        }
        if (continuationRemaining === 1) {
          continuePill.classList.add('warn');
          return;
        }
        continuePill.classList.add('ok');
      }

      function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
      }

      function isUserNearBottom() { return (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < scrollNearBottomThreshold; }
      function scrollToBottom(force) {
        // Webview DOM/layout can lag behind streaming updates; scroll after a frame.
        requestAnimationFrame(() => {
          if (!(force === true || autoScrollEnabled)) return;
          try {
            messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'auto' });
          } catch {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        });
      }

      function toast(text) {
        statusEl.textContent = text;
        if (!text) return;
        setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ''; }, 2500);
      }

      function iconForItem(item) {
        const p = String((item && item.path) || '').toLowerCase();
        if (p.endsWith('.py')) return '🐍';
        if (p.endsWith('.ts') || p.endsWith('.tsx')) return '🟦';
        if (p.endsWith('.js') || p.endsWith('.jsx')) return '🟨';
        if (p.endsWith('.json') || p.endsWith('.yaml') || p.endsWith('.yml')) return '🧩';
        if (p.endsWith('.md')) return '📝';
        if (p.endsWith('.css') || p.endsWith('.scss')) return '🎨';
        return '📄';
      }

      function renderActionLog() {
        if (!actionLogEl) return;
        actionLogEl.innerHTML = '';
        agentActions.slice(-120).forEach((entry) => {
          const row = document.createElement('div');
          row.className = 'agent-line ' + (entry.level || 'info');
          row.textContent = entry.text;
          actionLogEl.appendChild(row);
        });
        if (isStreaming) {
          const row = document.createElement('div');
          row.className = 'agent-line processing';
          row.innerHTML = '<span class="spinner">⟳</span> Working...';
          actionLogEl.appendChild(row);
        }
        actionLogEl.scrollTop = actionLogEl.scrollHeight;
      }

      function pushAction(item) {
        if (!item || !item.text) return;
        agentActions.push({ text: String(item.text), level: item.level || 'info', at: item.at || Date.now() });
        renderActionLog();
      }

      function renderTodos() {
        if (!todoListEl || !todoTitleEl) return;
        const done = agentTodos.filter((t) => t.status === 'completed').length;
        todoTitleEl.textContent = 'Plan (' + done + '/' + agentTodos.length + ')';
        todoListEl.innerHTML = '';
        agentTodos.forEach((t) => {
          const row = document.createElement('div');
          row.className = 'todo-item ' + (t.status === 'in-progress' ? 'active' : (t.status === 'completed' ? 'done' : 'pending'));
          const dot = t.status === 'completed' ? '✓' : (t.status === 'in-progress' ? '●' : '○');
          row.innerHTML = '<span class="todo-dot">' + dot + '</span><span>' + escHtml(t.text) + '</span>';
          todoListEl.appendChild(row);
        });
      }

      function renderChangeSummary() {
        if (!changeSummaryEl || !changeTextEl || !changeFilesEl) return;
        if (!latestChangeSummary || !latestChangeSummary.filesChanged) {
          changeSummaryEl.style.display = 'none';
          return;
        }
        changeSummaryEl.style.display = 'block';
        changeTextEl.innerHTML = latestChangeSummary.filesChanged + ' files changed <span class="delta-add">+' + latestChangeSummary.added + '</span> <span class="delta-del">-' + latestChangeSummary.removed + '</span>';
        changeFilesEl.innerHTML = (latestChangeSummary.files || []).map((f) => (
          '<div>' + escHtml(f.path) + ' <span class="delta-add">+' + Number(f.added || 0) + '</span> <span class="delta-del">-' + Number(f.removed || 0) + '</span></div>'
        )).join('');
      }

      function parsePathAndContent(code) {
        const lines = String(code || '').replace(/\\r\\n/g, '\\n').split('\\n');
        const first = lines.findIndex((l) => l.trim().length > 0);
        if (first < 0) return { path: 'unknown', content: '' };
        const m = lines[first].trim().match(/^path:\\s*(.+)$/i);
        if (!m) return { path: 'unknown', content: lines.join('\\n') };
        return { path: m[1].trim().replace(/^['"]|['"]$/g, ''), content: lines.slice(first + 1).join('\\n') };
      }

      function diffRowsHtml(lines, kind, startNo) {
        let n = startNo;
        return lines.map((line) => {
          n += 1;
          const sign = kind === 'add' ? '+' : '-';
          return '<div class="diff-row ' + (kind === 'add' ? 'add' : 'del') + '"><span class="ln">' + n + '</span><span class="sg">' + sign + '</span><span class="tx">' + escHtml(line) + '</span></div>';
        }).join('');
      }

      function renderDiffLikeBlock(lang, code) {
        const parsed = parsePathAndContent(code);
        const l = String(lang || '').toLowerCase();
        let body = '';
        let leftBody = '';
        let rightBody = '';
        let changed = 0;
        if (l === 'edit') {
          const text = String(parsed.content || '').replace(/\\r\\n/g, '\\n');
          const blocks = text.split('<<<<<<< SEARCH').slice(1);
          let lineNo = 0;
          blocks.forEach((b) => {
            const mid = b.split('=======');
            const end = (mid[1] || '').split('>>>>>>> REPLACE')[0] || '';
            const search = (mid[0] || '').trim().split('\\n').filter(Boolean);
            const replace = end.trim().split('\\n').filter(Boolean);
            changed += search.length + replace.length;
            body += '<div class="diff-ctx">··· context around edit chunk ···</div>';
            body += diffRowsHtml(search, 'del', lineNo);
            lineNo += search.length;
            body += diffRowsHtml(replace, 'add', lineNo);
            leftBody += diffRowsHtml(search, 'del', lineNo - search.length);
            rightBody += diffRowsHtml(replace, 'add', lineNo);
          });
          if (!body) {
            const fallback = parsed.content.split('\\n');
            body = diffRowsHtml(fallback, 'add', 0);
            rightBody = body;
            changed += fallback.length;
          }
        } else if (l === 'delete') {
          const lines = parsed.content.split('\\n').filter(Boolean);
          body = diffRowsHtml(lines.length ? lines : ['[file deleted]'], 'del', 0);
          leftBody = body;
          changed += Math.max(1, lines.length);
        } else {
          const lines = parsed.content.split('\\n');
          body = diffRowsHtml(lines, 'add', 0);
          rightBody = body;
          changed += Math.max(1, lines.length);
        }
        const scope = classifyScope(changed);
        const applyBtn = (l === 'file' || l === 'delete' || l === 'edit') ? ('<button class="code-btn apply-btn" data-lang="' + escHtml(l) + '">Keep</button>') : '';
        const toggleBtns = (l === 'file' || l === 'delete' || l === 'edit')
          ? '<button class="code-btn view-unified active">Unified</button><button class="code-btn view-split">Split</button>'
          : '';
        const statusTag = (l === 'file' || l === 'delete' || l === 'edit')
          ? '<span class="lang" style="margin-right:6px">' + escHtml(scope.toUpperCase()) + '</span>'
          : '';
        return '<div class="code-block-wrapper" data-scope="' + escHtml(scope) + '"><div class="code-block-header"><span class="lang">' + iconForItem({ path: parsed.path }) + ' ' + escHtml(parsed.path) + '</span><div class="code-block-actions">' + statusTag + toggleBtns + applyBtn + '<button class="code-btn reject-btn">Reject</button><button class="code-btn copy-btn">Copy</button></div></div><code style="display:none">' + escHtml(code) + '</code><div class="diff-rows unified-view">' + body + '</div><div class="diff-split split-view"><div class="diff-split-col"><div class="diff-split-hd">Original</div><div class="diff-split-body">' + (leftBody || '<div class="diff-ctx">(no removed lines)</div>') + '</div></div><div class="diff-split-col"><div class="diff-split-hd">Updated</div><div class="diff-split-body">' + (rightBody || '<div class="diff-ctx">(no added lines)</div>') + '</div></div></div></div>';
      }

      function addCodeBlockButtons(container) {
        const getActionableWrappers = () =>
          Array.from(container.querySelectorAll('.code-block-wrapper')).filter((w) => !!w.querySelector('.apply-btn'));

        const ensureBulkBar = () => {
          let bar = container.querySelector('.bulk-review-bar');
          const actionable = getActionableWrappers();
          if (!actionable.length) {
            if (bar) bar.remove();
            return;
          }

          if (!bar) {
            bar = document.createElement('div');
            bar.className = 'bulk-review-bar';
            bar.innerHTML =
              '<div class="bulk-review-meta"></div>' +
              '<div class="bulk-review-actions">' +
              '<button class="code-btn apply-all-kept">Apply all kept</button>' +
              '<button class="code-btn reject-all">Reject all</button>' +
              '</div>';
            const firstBlock = container.querySelector('.code-block-wrapper');
            if (firstBlock && firstBlock.parentNode) {
              firstBlock.parentNode.insertBefore(bar, firstBlock);
            } else {
              container.appendChild(bar);
            }

            const applyAllBtn = bar.querySelector('.apply-all-kept');
            const rejectAllBtn = bar.querySelector('.reject-all');

            if (applyAllBtn) {
              applyAllBtn.addEventListener('click', function() {
                const wrappers = getActionableWrappers();
                const count = wrappers.length;
                const byScope = { tiny: 0, small: 0, medium: 0, large: 0 };
                wrappers.forEach((w) => {
                  const scope = String(w.getAttribute('data-scope') || 'small').toLowerCase();
                  if (scope === 'tiny' || scope === 'small' || scope === 'medium' || scope === 'large') {
                    byScope[scope] += 1;
                  }
                  const applyBtn = w.querySelector('.apply-btn');
                  const codeEl = w.querySelector('code');
                  const lang = applyBtn ? (applyBtn.getAttribute('data-lang') || 'file') : 'file';
                  const code = codeEl ? (codeEl.textContent || '') : '';
                  vscode.postMessage({ type: 'applyFileBlockSilent', lang: lang, code: code });
                  w.remove();
                });
                ensureBulkBar();
                const parts = [];
                if (byScope.tiny) parts.push('TINY:' + byScope.tiny);
                if (byScope.small) parts.push('SMALL:' + byScope.small);
                if (byScope.medium) parts.push('MEDIUM:' + byScope.medium);
                if (byScope.large) parts.push('LARGE:' + byScope.large);
                toast('Applied ' + count + ' block' + (count === 1 ? '' : 's') + (parts.length ? ' (' + parts.join(', ') + ')' : ''));
              });
            }

            if (rejectAllBtn) {
              rejectAllBtn.addEventListener('click', function() {
                const wrappers = getActionableWrappers();
                const count = wrappers.length;
                const byScope = { tiny: 0, small: 0, medium: 0, large: 0 };
                wrappers.forEach((w) => {
                  const scope = String(w.getAttribute('data-scope') || 'small').toLowerCase();
                  if (scope === 'tiny' || scope === 'small' || scope === 'medium' || scope === 'large') {
                    byScope[scope] += 1;
                  }
                });
                wrappers.forEach((w) => w.remove());
                ensureBulkBar();
                const parts = [];
                if (byScope.tiny) parts.push('TINY:' + byScope.tiny);
                if (byScope.small) parts.push('SMALL:' + byScope.small);
                if (byScope.medium) parts.push('MEDIUM:' + byScope.medium);
                if (byScope.large) parts.push('LARGE:' + byScope.large);
                toast('Rejected ' + count + ' block' + (count === 1 ? '' : 's') + (parts.length ? ' (' + parts.join(', ') + ')' : ''));
              });
            }
          }

          const meta = bar.querySelector('.bulk-review-meta');
          if (meta) {
            const count = actionable.length;
            meta.textContent = count + ' block' + (count === 1 ? '' : 's') + ' pending review';
          }
        };

        ensureBulkBar();

        container.querySelectorAll('.code-block-wrapper').forEach(function(wrapper) {
          const codeEl = wrapper.querySelector('code');
          const code = codeEl ? codeEl.textContent : '';
          const parsed = parsePathAndContent(code || '');
          const fileLabel = parsed && parsed.path ? parsed.path : 'file';
          const copyBtn = wrapper.querySelector('.copy-btn');
          const insertBtn = wrapper.querySelector('.insert-btn');
          const applyBtn = wrapper.querySelector('.apply-btn');
          const fetchBtn = wrapper.querySelector('.fetch-btn');
          const rejectBtn = wrapper.querySelector('.reject-btn');
          const unifiedBtn = wrapper.querySelector('.view-unified');
          const splitBtn = wrapper.querySelector('.view-split');
          const unifiedView = wrapper.querySelector('.unified-view');
          const splitView = wrapper.querySelector('.split-view');
          const scope = String(wrapper.getAttribute('data-scope') || 'small');
          const scopeLabel = scope.toUpperCase();

          const setView = (mode) => {
            if (unifiedView) unifiedView.style.display = mode === 'unified' ? 'block' : 'none';
            if (splitView) splitView.style.display = mode === 'split' ? 'grid' : 'none';
            if (unifiedBtn) unifiedBtn.classList.toggle('active', mode === 'unified');
            if (splitBtn) splitBtn.classList.toggle('active', mode === 'split');
          };
          setView('unified');

          if (unifiedBtn) unifiedBtn.addEventListener('click', function() { setView('unified'); });
          if (splitBtn) splitBtn.addEventListener('click', function() { setView('split'); });
          if (copyBtn) copyBtn.addEventListener('click', function() {
            navigator.clipboard.writeText(code).then(function() {
              copyBtn.textContent = 'Copied!';
              setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1200);
            });
          });
          if (insertBtn) insertBtn.addEventListener('click', function() { vscode.postMessage({ type: 'copyToEditor', code }); });
          if (applyBtn) applyBtn.addEventListener('click', function() {
            const lang = applyBtn.getAttribute('data-lang') || 'file';
            vscode.postMessage({ type: 'applyFileBlock', lang: lang, code: code });
            wrapper.remove();
            ensureBulkBar();
            toast('Applied ' + scopeLabel + ' block for ' + fileLabel);
          });
          if (fetchBtn) fetchBtn.addEventListener('click', function() { vscode.postMessage({ type: 'fetchRequestedFiles', code: code }); });
          if (rejectBtn) rejectBtn.addEventListener('click', function() {
            wrapper.remove();
            ensureBulkBar();
            toast('Rejected ' + scopeLabel + ' block for ' + fileLabel);
          });

          if (autoApplyArmed && applyBtn) {
            if (scope === 'tiny') {
              setTimeout(function() {
                if (!wrapper.isConnected) return;
                vscode.postMessage({ type: 'applyFileBlockSilent', lang: applyBtn.getAttribute('data-lang') || 'file', code: code });
                wrapper.remove();
                ensureBulkBar();
              }, 150);
            } else if (scope === 'small') {
              let sec = 3;
              applyBtn.textContent = 'Keep (' + sec + ')';
              const timer = setInterval(function() {
                if (!wrapper.isConnected) {
                  clearInterval(timer);
                  return;
                }
                sec -= 1;
                if (sec <= 0) {
                  clearInterval(timer);
                  vscode.postMessage({ type: 'applyFileBlockSilent', lang: applyBtn.getAttribute('data-lang') || 'file', code: code });
                  wrapper.remove();
                  ensureBulkBar();
                  return;
                }
                applyBtn.textContent = 'Keep (' + sec + ')';
              }, 1000);
            }
          }
        });
      }

      function markdownToHtml(text) {
        const FENCE = '\\x60\\x60\\x60';
        const parts = String(text || '').split(new RegExp('(' + FENCE + '(?:\\\\w*)\\\\n?[\\\\s\\\\S]*?' + FENCE + ')', 'g'));
        text = parts.map(function(part) {
          if (part.indexOf(FENCE) === 0) {
            const afterFence = part.slice(3);
            const nl = afterFence.indexOf('\\n');
            const lang = nl > -1 ? afterFence.slice(0, nl).trim() : 'code';
            const rest = nl > -1 ? afterFence.slice(nl + 1) : afterFence;
            const lastFence = rest.lastIndexOf(FENCE);
            const code = lastFence > -1 ? rest.slice(0, lastFence).trim() : rest.trim();
            const l = (lang || 'code').toLowerCase();
            if (l === 'edit' || l === 'file' || l === 'delete' || l === 'diff') {
              return renderDiffLikeBlock(l, code);
            }
            const applyBtn = (l === 'file' || l === 'delete' || l === 'edit') ? ('<button class="code-btn apply-btn" data-lang="' + escHtml(l) + '">Apply</button>') : '';
            const fetchBtn = (l === 'request') ? ('<button class="code-btn fetch-btn">Fetch</button>') : '';
            const isFileOp = (l === 'file' || l === 'delete');
            const insertBtn = (!isFileOp && l !== 'request') ? '<button class="code-btn insert-btn">Insert</button>' : '';
            return '<div class="code-block-wrapper"><div class="code-block-header"><span class="lang">' + escHtml(lang || 'code') + '</span><div class="code-block-actions">' + fetchBtn + applyBtn + insertBtn + '<button class="code-btn copy-btn">Copy</button></div></div><pre><code>' + escHtml(code) + '</code></pre></div>';
          }
          return escHtml(part);
        }).join('');
        text = text.replace(/\\n/g, '<br>');
        text = text.replace(/<pre>([\\s\\S]*?)<\\/pre>/g, function(m, inner) { return '<pre>' + inner.replace(/<br>/g, '\\n') + '</pre>'; });
        // light inline markdown on the escaped text
        text = text.replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
        text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
        return text;
      }

      function appendUserMessage(text) {
        autoScrollEnabled = true;
        const elMsg = document.createElement('div');
        elMsg.className = 'message user';
        elMsg.innerHTML = '<div class="msg-label">You</div><div class="msg-content">' + escHtml(text) + '</div>';
        messagesEl.appendChild(elMsg);
        scrollToBottom(true);
      }

      function appendAssistantMessage(text) {
        autoScrollEnabled = true;
        const elMsg = document.createElement('div');
        elMsg.className = 'message assistant';
        elMsg.innerHTML = '<div class="msg-label">Azure Codex</div><div class="msg-content">' + markdownToHtml(text) + '</div>';
        messagesEl.appendChild(elMsg);
        addCodeBlockButtons(elMsg);
        scrollToBottom(true);
      }

      function startAssistantMessage() {
        autoApplyArmed = false;
        isStreaming = true;
        sendBtn.disabled = false;
        inputEl.disabled = false;
        stopBtn.disabled = false;
        stopBtn.classList.remove('hidden');
        if (continueBtn) continueBtn.classList.add('hidden');
        if (continuePill) {
          continuePill.classList.remove('hidden');
          updateContinuationPill();
        }
        rawBuffer = '';
        autoScrollEnabled = true;
        currentMsgEl = document.createElement('div');
        currentMsgEl.className = 'message assistant';
        currentMsgEl.innerHTML = '<div class="msg-label">Azure Codex</div>';
        currentStatusBarEl = document.createElement('div');
        currentStatusBarEl.className = 'agent-status';
        currentStatusBarEl.textContent = '🔍 Searching your project...';
        currentMsgEl.appendChild(currentStatusBarEl);
        currentContentEl = document.createElement('div');
        currentContentEl.className = 'msg-content';
        currentMsgEl.appendChild(currentContentEl);
        messagesEl.appendChild(currentMsgEl);
        generatedTokenCount = 0;
        statusEl.textContent = '⟳ generating... (0 tokens)';
        progressContainerEl.style.display = 'block';
        renderActionLog();
        scrollToBottom(true);
      }

      function appendToken(token) {
        rawBuffer += token;
        if (currentContentEl) {
          currentContentEl.innerHTML = markdownToHtml(rawBuffer);
        }
        scrollToBottom();
      }

      function finishAssistantMessage() {
        isStreaming = false;
        sendBtn.disabled = false;
        inputEl.disabled = false;
        stopBtn.disabled = true;
        stopBtn.classList.add('hidden');
        statusEl.textContent = '';
        progressContainerEl.style.display = 'none';
        if (currentStatusBarEl) currentStatusBarEl.style.display = 'none';
        if (continuePill && continueBtn && continueBtn.classList.contains('hidden')) continuePill.classList.add('hidden');
        currentStatusBarEl = null;
        if (currentContentEl) addCodeBlockButtons(currentMsgEl);
        currentMsgEl = null; currentContentEl = null; rawBuffer = '';
        renderActionLog();
      }

      function stopAssistantMessage() {
        isStreaming = false;
        sendBtn.disabled = false;
        inputEl.disabled = false;
        stopBtn.disabled = true;
        stopBtn.classList.add('hidden');
        if (continueBtn) continueBtn.classList.add('hidden');
        statusEl.textContent = '';
        progressContainerEl.style.display = 'none';
        if (currentStatusBarEl) currentStatusBarEl.style.display = 'none';
        if (continuePill && continueBtn && continueBtn.classList.contains('hidden')) continuePill.classList.add('hidden');
        currentStatusBarEl = null;
        if (currentContentEl) addCodeBlockButtons(currentMsgEl);
        currentMsgEl = null; currentContentEl = null; rawBuffer = '';
        renderActionLog();
      }

      function showError(text) {
        isStreaming = false;
        sendBtn.disabled = false;
        inputEl.disabled = false;
        stopBtn.disabled = true;
        stopBtn.classList.add('hidden');
        if (continueBtn) continueBtn.classList.add('hidden');
        statusEl.textContent = '';
        progressContainerEl.style.display = 'none';
        if (currentStatusBarEl) currentStatusBarEl.style.display = 'none';
        if (continuePill && continueBtn && continueBtn.classList.contains('hidden')) continuePill.classList.add('hidden');
        currentStatusBarEl = null;
        if (currentMsgEl) currentMsgEl.remove();
        const elMsg = document.createElement('div');
        elMsg.className = 'message error';
        elMsg.textContent = 'Error: ' + text;
        messagesEl.appendChild(elMsg);
        scrollToBottom(true);
      }

      function renderChats() {
        chatListEl.innerHTML = '';
        (state.chats || []).forEach((c) => {
          const row = document.createElement('div');
          row.className = 'row';
          row.style.cursor = 'pointer';
          if (c.id === state.activeId) row.style.outline = '1px solid var(--focus)';
          row.innerHTML = '<div class="left"><div class="title">' + escHtml(c.title || 'Chat') + '</div><div class="meta">' + new Date(c.createdAt || Date.now()).toLocaleString() + '</div></div>' +
            '<div class="actions"><button class="mini">Open</button></div>';
          row.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'selectChat', id: c.id }); });
          row.addEventListener('click', () => vscode.postMessage({ type: 'selectChat', id: c.id }));
          chatListEl.appendChild(row);
        });
      }

      function renderTranscript(transcript) {
        messagesEl.innerHTML = '';
        (transcript || []).forEach((m) => {
          if (m.role === 'user') appendUserMessage(m.content);
          else if (m.role === 'assistant') appendAssistantMessage(m.content);
        });
        autoScrollEnabled = true;
        scrollToBottom(true);
      }

      function renderFiles() {
        const q = String(fileFilterEl.value || '').toLowerCase().trim();
        const files = (workspaceFiles || []).filter((p) => !q || String(p).toLowerCase().includes(q)).slice(0, 200);
        fileListEl.innerHTML = '';
        if (!files.length) {
          const d = document.createElement('div');
          d.className = 'hint';
          d.textContent = q ? 'No matches.' : 'No files (open a workspace).';
          fileListEl.appendChild(d);
          return;
        }
        files.forEach((p) => {
          const row = document.createElement('div');
          row.className = 'row';
          row.innerHTML = '<div class="left"><div class="title">' + escHtml(p) + '</div><div class="meta">Workspace file</div></div>' +
            '<div class="actions"><button class="mini">Add</button><button class="mini">Open</button></div>';
          const btns = row.querySelectorAll('button');
          btns[0].addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'pinWorkspaceFile', path: p }); });
          btns[1].addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openFile', path: p }); });
          fileListEl.appendChild(row);
        });
      }

      function renderContext() {
        const pinned = (contextStatus && contextStatus.pinned) ? contextStatus.pinned : { items: [] };
        const items = pinned.items || [];
        const tiers = pinned.tiers || { persistent: [], conversation: [], oneTime: [] };
        ctxSummaryEl.textContent = items.length
          ? ('Persistent: ' + (tiers.persistent || []).length + ' · Conversation: ' + (tiers.conversation || []).length + ' · One-time: ' + (tiers.oneTime || []).length)
          : 'No context references yet.';

        const byId = new Map(items.map((it) => [it.id, it]));
        const persistentItems = (tiers.persistent || []).map((id) => byId.get(id)).filter(Boolean);
        const conversationItems = (tiers.conversation || []).map((id) => byId.get(id)).filter(Boolean);
        const oneTimeItems = (tiers.oneTime || []).map((id) => byId.get(id)).filter(Boolean);

        // chips above input
        chipsEl.innerHTML = '';
        items.forEach((i) => {
          const chip = document.createElement('div');
          chip.className = 'chip' + (i.source === 'auto' ? ' auto' : '');
          const prefix = i.source === 'auto' ? '🤖 ' : '';
          const tierBadge = i.tier === 'persistent' ? '📌' : (i.tier === 'oneTime' ? '1×' : '💬');
          chip.innerHTML = '<span>' + prefix + iconForItem(i) + ' ' + tierBadge + '</span><code>' + escHtml(i.path) + '</code><button class="x" title="Remove">×</button>';
          chip.querySelector('button').addEventListener('click', () => vscode.postMessage({ type: 'removeContextItem', kind: i.kind, label: i.id }));
          chip.addEventListener('click', () => vscode.postMessage({ type: 'previewContextItem', id: i.id }));
          chipsEl.appendChild(chip);
        });

        // right list
        ctxListEl.innerHTML = '';
        if (!items.length) {
          const d = document.createElement('div');
          d.className = 'hint';
          d.textContent = 'Use +, drag & drop, or paste an absolute file path in chat.';
          ctxListEl.appendChild(d);
          return;
        }

        function renderTier(title, list, tierKey) {
          if (!list.length) return;
          const h = document.createElement('div');
          h.className = 'hint';
          h.style.margin = '8px 0 4px';
          h.textContent = title + ' (drag to reorder)';
          ctxListEl.appendChild(h);

          const tierContainer = document.createElement('div');
          tierContainer.className = 'list';
          tierContainer.dataset.tier = tierKey;
          ctxListEl.appendChild(tierContainer);

          let dragId = null;

          const postOrder = () => {
            const ids = Array.from(tierContainer.querySelectorAll('[data-context-id]')).map((n) => n.getAttribute('data-context-id')).filter(Boolean);
            if (!ids.length) return;
            vscode.postMessage({ type: 'reorderContextTier', tier: tierKey, ids });
          };

          list.forEach((i) => {
            const row = document.createElement('div');
            row.className = 'row';
            row.style.cursor = 'pointer';
            row.draggable = true;
            row.setAttribute('data-context-id', String(i.id));
            const stateBits = [];
            if (i.isMissingOnDisk) stateBits.push('missing on disk');
            if (i.isChangedOnDisk) stateBits.push('changed on disk');
            if (i.tokenCount) stateBits.push('~' + i.tokenCount + ' tok');
            const meta = (i.kind || 'file') + ' · ' + (i.language || 'text') + ' · ' + Math.round((i.sizeBytes||0)/1024) + 'KB' + (stateBits.length ? (' · ' + stateBits.join(' · ')) : '');
            row.innerHTML = '<div class="left"><div class="title">↕ ' + escHtml(i.path) + '</div>' +
              '<div class="meta">' + escHtml(meta) + '</div></div>' +
              '<div class="actions"></div>';
            const actions = row.querySelector('.actions');

            const mkBtn = (label, cb) => {
              const b = document.createElement('button');
              b.className = 'mini';
              b.textContent = label;
              b.addEventListener('click', (e) => { e.stopPropagation(); cb(); });
              actions.appendChild(b);
            };

            mkBtn('Preview', () => vscode.postMessage({ type: 'previewContextItem', id: i.id }));
            mkBtn(i.tier === 'persistent' ? 'Unpin' : 'Pin', () => vscode.postMessage({ type: 'togglePersistentContextItem', id: i.id, persistent: i.tier !== 'persistent' }));
            mkBtn(i.tier === 'oneTime' ? 'Always' : '1×', () => vscode.postMessage({ type: 'toggleOneTimeContextItem', id: i.id, oneTime: i.tier !== 'oneTime' }));
            if (i.isMissingOnDisk || i.isChangedOnDisk) {
              mkBtn('Reload', () => vscode.postMessage({ type: 'reloadContextItem', id: i.id }));
            }
            if (i.isChangedOnDisk && !i.stalePromptDismissed) {
              mkBtn('Keep', () => vscode.postMessage({ type: 'dismissStaleContextItem', id: i.id }));
            }
            mkBtn('Remove', () => vscode.postMessage({ type: 'removeContextItem', kind: i.kind, label: i.id }));

            row.addEventListener('dragstart', (e) => {
              dragId = String(i.id);
              row.classList.add('dragging');
              try {
                if (e && e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', dragId || '');
                }
              } catch {
                // ignore
              }
            });

            row.addEventListener('dragend', () => {
              row.classList.remove('dragging');
              Array.from(tierContainer.querySelectorAll('.row.drag-over')).forEach((n) => n.classList.remove('drag-over'));
              if (dragId) {
                postOrder();
              }
              dragId = null;
            });

            row.addEventListener('dragover', (e) => {
              if (!dragId || dragId === String(i.id)) return;
              e.preventDefault();
              row.classList.add('drag-over');
            });

            row.addEventListener('dragleave', () => {
              row.classList.remove('drag-over');
            });

            row.addEventListener('drop', (e) => {
              if (!dragId || dragId === String(i.id)) return;
              e.preventDefault();
              row.classList.remove('drag-over');
              const dragging = tierContainer.querySelector('[data-context-id="' + dragId + '"]');
              if (!dragging || dragging === row) return;

              const rect = row.getBoundingClientRect();
              const before = (e.clientY - rect.top) < (rect.height / 2);
              if (before) tierContainer.insertBefore(dragging, row);
              else tierContainer.insertBefore(dragging, row.nextSibling);
            });

            row.addEventListener('click', () => vscode.postMessage({ type: 'previewContextItem', id: i.id }));
            tierContainer.appendChild(row);
          });
        }

        renderTier('📌 Persistent workspace refs', persistentItems, 'persistent');
        renderTier('💬 Conversation refs', conversationItems, 'conversation');
        renderTier('1× One-time refs', oneTimeItems, 'oneTime');
      }

      function renderPreview(item) {
        lastPreviewItem = item || null;
        openPreviewBtn.disabled = !lastPreviewItem || lastPreviewItem.source !== 'workspace' || !lastPreviewItem.path || lastPreviewItem.path.startsWith('/');
        previewEl.innerHTML = '';
        if (!item) {
          previewEl.innerHTML = '<div class="hint">Select a context file to preview.</div>';
          return;
        }
        if (item.kind === 'image' && item.dataUrl) {
          const img = document.createElement('img');
          img.src = item.dataUrl;
          previewEl.appendChild(img);
          return;
        }
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = String(item.text || '[no preview]');
        pre.appendChild(code);
        previewEl.appendChild(pre);
      }

      function sendMessage() {
        const text = String(inputEl.value || '').trim();
        if (!text) return;
        inputEl.value = '';
        inputEl.style.height = 'auto';
        vscode.postMessage({ type: 'userMessage', text, mode: String((modeEl && modeEl.value) || 'Auto').toLowerCase() });
      }

      function on(node, event, handler, options) {
        if (!node || typeof node.addEventListener !== 'function') return;
        node.addEventListener(event, handler, options);
      }

      on(inputEl, 'input', () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
      });
      on(inputEl, 'keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      });

      on(sendBtn, 'click', sendMessage);
      on(sendOptionsEl, 'click', () => {
        sendMenuEl.style.display = sendMenuEl.style.display === 'block' ? 'none' : 'block';
      });
      on(sendNowEl, 'click', () => {
        sendMenuEl.style.display = 'none';
        sendMessage();
      });
      on(sendQueueEl, 'click', () => {
        sendMenuEl.style.display = 'none';
        sendMessage();
      });
      on(stopBtn, 'click', () => { if (isStreaming) vscode.postMessage({ type: 'stopGeneration' }); });
      on(continueBtn, 'click', () => {
        vscode.postMessage({
          type: 'userMessage',
          text: continuationSuggestedText,
          mode: String((modeEl && modeEl.value) || 'Auto').toLowerCase()
        });
        continueBtn.classList.add('hidden');
      });
      on(undoBtn, 'click', () => { if (!undoBtn.disabled) vscode.postMessage({ type: 'undoLastApply' }); });
      on(undoChangesEl, 'click', () => vscode.postMessage({ type: 'undoLastApply' }));
      on(keepChangesEl, 'click', () => {
        latestChangeSummary = null;
        renderChangeSummary();
      });
      on(toggleChangesEl, 'click', () => {
        const open = !changeFilesEl.classList.contains('on');
        changeFilesEl.classList.toggle('on', open);
        toggleChangesEl.textContent = open ? '⌄' : '>';
      });
      on(toggleActionsEl, 'click', () => {
        const collapsed = actionCardEl.classList.toggle('collapsed');
        toggleActionsEl.textContent = collapsed ? '▸' : '▾';
      });
      on(toggleTodosEl, 'click', () => {
        const collapsed = todoCardEl.classList.toggle('collapsed');
        toggleTodosEl.textContent = collapsed ? '▸' : '▾';
      });
      on(el('attach'), 'click', () => vscode.postMessage({ type: 'pickAttachments' }));
      on(el('clear'), 'click', () => vscode.postMessage({ type: 'clearHistory' }));
      on(el('settings'), 'click', () => vscode.postMessage({ type: 'openSettings' }));
      on(el('new-chat'), 'click', () => vscode.postMessage({ type: 'newChat' }));
      on(el('new-chat-top'), 'click', () => vscode.postMessage({ type: 'newChat' }));
      on(el('clear-conversation-context'), 'click', () => vscode.postMessage({ type: 'clearConversationContext' }));
      on(el('clear-nonpersistent-context'), 'click', () => vscode.postMessage({ type: 'clearNonPersistentContext' }));
      on(el('refresh-files'), 'click', () => vscode.postMessage({ type: 'getWorkspaceFiles' }));
      on(fileFilterEl, 'input', renderFiles);

      on(openPreviewBtn, 'click', () => {
        if (!lastPreviewItem) return;
        vscode.postMessage({ type: 'openFile', path: lastPreviewItem.path });
      });

      // Drag & drop
      let dragDepth = 0;
      function showDrop(on) { dropEl.classList.toggle('on', !!on); }
      window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; showDrop(true); });
      window.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
      window.addEventListener('dragover', (e) => { e.preventDefault(); });
      window.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragDepth = 0;
        showDrop(false);
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) ? e.dataTransfer.files : []);
        if (!files.length) return;
        const payload = [];
        for (const f of files.slice(0, 10)) {
          const buf = await f.arrayBuffer();
          const u8 = new Uint8Array(buf);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < u8.length; i += chunk) {
            binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
          }
          const base64 = btoa(binary);
          payload.push({ name: f.name, mime: f.type || '', base64 });
        }
        vscode.postMessage({ type: 'uploadAttachments', files: payload });
      });

      // Scroll FAB logic
      function updateScrollFab() {
        const isNearBottom = isUserNearBottom();
        autoScrollEnabled = isNearBottom;
        scrollFabEl.style.display = isNearBottom ? 'none' : 'flex';
      }
      on(messagesEl, 'scroll', updateScrollFab, { passive: true });
      on(scrollFabEl, 'click', () => scrollToBottom(true));

      // Some VS Code webview hosts can swallow wheel scrolling unless the scroll container
      // explicitly consumes it (especially when nested inside grid/flex).
      on(messagesEl, 'wheel', (e) => {
        const canScroll = messagesEl.scrollHeight > messagesEl.clientHeight + 1;
        if (!canScroll) return;
        // Let code blocks scroll horizontally/vertically when hovered.
        const t = e.target;
        if (t && t.closest && t.closest('pre')) return;
        messagesEl.scrollTop += (e.deltaY || 0);
        e.preventDefault();
      }, { passive: false });

      window.addEventListener('message', (event) => {
        const msg = event.data || {};
        switch (msg.type) {
          case 'chatState':
            state = msg.state || state;
            scrollNearBottomThreshold = msg.state.scrollNearBottomThreshold || 120;
            renderChats();
            renderTranscript(state.transcript || []);
            break;
          case 'workspaceFiles':
            workspaceFiles = msg.files || [];
            renderFiles();
            break;
          case 'userMessage': appendUserMessage(msg.text); break;
          case 'commandMessage': appendUserMessage('(' + msg.label + ') ' + String(msg.text || '').slice(0, 120)); break;
          case 'assistantStart': startAssistantMessage(); break;
          case 'assistantToken': appendToken(msg.token || ''); break;
          case 'assistantDone': finishAssistantMessage(); break;
          case 'assistantStopped': stopAssistantMessage(); break;
          case 'error': showError(msg.text || 'Unknown error'); break;
          case 'generationStatus':
            if (isStreaming) {
              const phase = String(msg.text || '').trim();
              statusEl.textContent = phase
                ? (phase + ' · generating... (' + generatedTokenCount.toLocaleString() + ' tokens)')
                : ('⟳ generating... (' + generatedTokenCount.toLocaleString() + ' tokens)');
            } else {
              statusEl.textContent = String(msg.text || '');
            }
            if (currentStatusBarEl) {
              const txt = String(msg.text || '');
              if (/reading/i.test(txt)) currentStatusBarEl.textContent = '📂 ' + txt;
              else if (/thinking|search/i.test(txt)) currentStatusBarEl.textContent = '🔍 ' + txt;
              else if (/writing/i.test(txt)) currentStatusBarEl.textContent = '✏️ ' + txt;
              else if (/final/i.test(txt)) currentStatusBarEl.textContent = '🧠 ' + txt;
              else if (txt) currentStatusBarEl.textContent = txt;
            }
            break;
          case 'generationMetrics':
            generatedTokenCount = Number(msg.tokens || 0);
            if (isStreaming) {
              const current = String(statusEl.textContent || '');
              const phase = current.includes('·') ? current.split('·')[0].trim() : '';
              statusEl.textContent = phase
                ? (phase + ' · generating... (' + generatedTokenCount.toLocaleString() + ' tokens)')
                : ('⟳ generating... (' + generatedTokenCount.toLocaleString() + ' tokens)');
            }
            break;
          case 'continuationExhausted':
            continuationSuggestedText = String(msg.suggestedText || continuationSuggestedText);
            continuationRemaining = Number.isFinite(Number(msg.remaining)) ? Number(msg.remaining) : 0;
            continuationMax = Number.isFinite(Number(msg.max)) ? Number(msg.max) : continuationMax;
            if (continueBtn) continueBtn.classList.remove('hidden');
            if (continuePill) {
              continuePill.classList.remove('hidden');
              updateContinuationPill();
            }
            break;
          case 'continuationState':
            if (Number.isFinite(Number(msg.remaining))) continuationRemaining = Number(msg.remaining);
            if (Number.isFinite(Number(msg.max))) continuationMax = Number(msg.max);
            if (continueBtn) {
              const visible = !!msg.visible;
              continueBtn.classList.toggle('hidden', !visible);
            }
            if (continuePill) {
              updateContinuationPill();
              const shouldShow = isStreaming || !continueBtn.classList.contains('hidden');
              continuePill.classList.toggle('hidden', !shouldShow);
            }
            break;
          case 'agentAction':
            pushAction(msg.item || {});
            if (actionCardEl && actionCardEl.classList.contains('collapsed')) {
              actionCardEl.classList.remove('collapsed');
              if (toggleActionsEl) toggleActionsEl.textContent = '▾';
            }
            break;
          case 'terminalLine':
            pushAction({
              text: String(msg.text || ''),
              level: msg.level === 'warn' ? 'warn' : msg.level === 'ok' ? 'ok' : 'info',
              at: Date.now()
            });
            if (actionCardEl && actionCardEl.classList.contains('collapsed')) {
              actionCardEl.classList.remove('collapsed');
              if (toggleActionsEl) toggleActionsEl.textContent = '▾';
            }
            break;
          case 'agentTodos':
            agentTodos = Array.isArray(msg.items) ? msg.items : [];
            renderTodos();
            if (todoCardEl && todoCardEl.classList.contains('collapsed')) {
              todoCardEl.classList.remove('collapsed');
              if (toggleTodosEl) toggleTodosEl.textContent = '▾';
            }
            break;
          case 'changeSummary':
            latestChangeSummary = msg.summary || null;
            renderChangeSummary();
            break;
          case 'clearHistory': messagesEl.innerHTML = ''; break;
          case 'contextStatus':
            contextStatus = msg.status || null;
            renderContext();
            break;
          case 'contextPreview':
            renderPreview(msg.item || null);
            break;
          case 'undoStatus':
            undoStatus = msg.status || undoStatus;
            undoBtn.disabled = !(msg.status && msg.status.canUndo);
            undoBtn.title = (msg.status && msg.status.label) ? ('Undo: ' + msg.status.label) : 'Undo last applied change';
            const changesEl = el('changes');
            if (changesEl) {
              const lbl = (undoStatus && undoStatus.label) ? String(undoStatus.label) : '';
              const paths = (undoStatus && undoStatus.paths) ? undoStatus.paths : [];
              changesEl.textContent = lbl ? ('Last change: ' + lbl + (paths && paths.length ? (' · ' + paths.slice(0,3).join(', ') + (paths.length > 3 ? ', …' : '')) : '')) : '';
            }
            break;
          case 'toast':
            toast(String(msg.text || ''));
            break;
          case 'autoApplyArmed':
            autoApplyArmed = true;
            toast('Auto-apply policy armed for this response');
            break;
        }
      });

      vscode.postMessage({ type: 'getContextStatus' });
      vscode.postMessage({ type: 'getWorkspaceFiles' });
      inputEl.focus();
    </script>
  </body>
</html>`;
}
