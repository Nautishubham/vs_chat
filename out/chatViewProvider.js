"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const chatHTML_1 = require("./chatHTML");
const child_process_1 = require("child_process");
const util_1 = require("util");
const agentSession_1 = require("./agentSession");
const agentReviewPanel_1 = require("./agentReviewPanel");
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const XLSX = __importStar(require("xlsx"));
const mammoth = __importStar(require("mammoth"));
const jszip_1 = __importDefault(require("jszip"));
class ChatViewProvider {
    constructor(_extensionUri, _client, _deps) {
        this._extensionUri = _extensionUri;
        this._client = _client;
        this._deps = _deps;
        this._history = [];
        this._pinnedTextFiles = new Map();
        this._pinnedImages = new Map(); // path -> data URL
        this._undoBatches = [];
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = (0, chatHTML_1.getChatHTML)();
        this._sendContextStatus();
        this._sendUndoStatus();
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'userMessage':
                    await this._handleUserMessage(data.text);
                    break;
                case 'stopGeneration':
                    this._stopGeneration();
                    break;
                case 'clearHistory':
                    this.clearHistory();
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', 'azureCodex');
                    break;
                case 'copyToEditor':
                    await this._insertCodeToEditor(data.code);
                    break;
                case 'applyFileBlock':
                    await this._applyFileBlock(data.lang, data.code);
                    break;
                case 'pickAttachments':
                    await this._pickAttachments();
                    break;
                case 'removeContextItem':
                    await this._removeContextItem(data.kind, data.label);
                    break;
                case 'fetchRequestedFiles':
                    await this._fetchRequestedFiles(data.code);
                    break;
                case 'getContextStatus':
                    this._sendContextStatus();
                    break;
                case 'setConfig':
                    await this._setConfig(data.key, data.value);
                    break;
                case 'undoLastApply':
                    await this._undoLastApply();
                    break;
            }
        });
    }
    async _handleUserMessage(text, opts) {
        if (!this._view)
            return;
        if (!this._client.isConfigured()) {
            this._sendToWebview({ type: 'error', text: this._client.getConfigError() });
            return;
        }
        // Cancel any in-flight generation before starting a new one.
        this._stopGeneration();
        const config = vscode.workspace.getConfiguration('azureCodex');
        const agentEnabled = config.get('agentEnabled', false);
        // Show user message
        this._sendToWebview({ type: 'userMessage', text: opts?.displayText ?? text });
        if (agentEnabled) {
            await this._runAgent(text);
            return;
        }
        // Start streaming assistant response
        this._sendToWebview({ type: 'assistantStart' });
        const contextMessages = await this._buildContextMessages(text);
        const historyWithContext = [...contextMessages, ...this._history];
        const abort = new AbortController();
        this._currentAbort = abort;
        const model = this._deps?.modelRouter?.getChatDeployment(vscode.workspace.getConfiguration('azureCodex').get('deploymentName', 'gpt-5-2-codex-max'));
        const autoContinueEnabled = config.get('autoContinueOnTruncation', true);
        const autoContinueMaxTurns = Math.max(1, Math.min(10, config.get('autoContinueMaxTurns', 4)));
        let fullResponse = '';
        let scratchHistory = [...historyWithContext];
        let userContent = this._buildUserContent(text);
        let hadError = false;
        for (let turn = 1; turn <= autoContinueMaxTurns; turn++) {
            if (abort.signal.aborted)
                break;
            let turnText = '';
            let endMeta = undefined;
            await this._client.chat(scratchHistory, userContent, {
                onToken: (token) => {
                    turnText += token;
                    fullResponse += token;
                    this._sendToWebview({ type: 'assistantToken', token });
                },
                onDone: (meta) => {
                    endMeta = meta;
                },
                onError: (error) => {
                    hadError = true;
                    const normalized = String(error || '');
                    if (normalized.toLowerCase() === 'canceled') {
                        this._sendToWebview({ type: 'assistantStopped' });
                    }
                    else {
                        this._sendToWebview({ type: 'error', text: error });
                    }
                }
            }, { signal: abort.signal, model });
            if (hadError || abort.signal.aborted)
                break;
            // Extend the scratch conversation so the model can continue seamlessly.
            scratchHistory = [...scratchHistory, { role: 'user', content: userContent }, { role: 'assistant', content: turnText }];
            const shouldContinue = autoContinueEnabled && turn < autoContinueMaxTurns && this._looksTruncated(fullResponse, endMeta);
            if (!shouldContinue)
                break;
            userContent = this._buildAutoContinuePrompt(fullResponse);
        }
        this._currentAbort = undefined;
        if (hadError || abort.signal.aborted)
            return;
        // Save to history (only the original user message + the full assistant output).
        this._history.push({ role: 'user', content: text });
        this._history.push({ role: 'assistant', content: fullResponse });
        if (this._history.length > 20) {
            this._history = this._history.slice(-20);
        }
        this._sendToWebview({ type: 'assistantDone' });
        this._autoApplyIfEnabled(fullResponse).catch(() => { });
    }
    _looksTruncated(text, endMeta) {
        const finishReason = String(endMeta?.finishReason || '').toLowerCase();
        if (endMeta?.incomplete)
            return true;
        if (finishReason === 'length' || finishReason === 'max_output_tokens')
            return true;
        if (this._getOpenFenceInfo(text) !== null)
            return true;
        return this._looksLikeLeadInWithoutBody(text);
    }
    _looksLikeLeadInWithoutBody(text) {
        const t = String(text || '').trim();
        if (!t)
            return false;
        if (t.length > 500)
            return false;
        if (t.includes('```'))
            return false;
        const tail = t.slice(-250).toLowerCase();
        const lastChar = t.slice(-1);
        const endsLikeLeadIn = lastChar === ':' || tail.endsWith('below.') || tail.endsWith('below:') || tail.endsWith('below');
        if (!endsLikeLeadIn)
            return false;
        // Common "I will paste code now" lead-ins that often get cut off by the model/UI.
        const intent = tail.includes('continuation') ||
            tail.includes('continue') ||
            tail.includes('re-sending') ||
            tail.includes('resending') ||
            tail.includes('re-send') ||
            tail.includes('sending the complete') ||
            tail.includes('here is') ||
            tail.includes('here’s') ||
            tail.includes('heres');
        // Avoid triggering on genuine short conversational replies.
        return intent;
    }
    _buildAutoContinuePrompt(assistantSoFar) {
        const open = this._getOpenFenceInfo(assistantSoFar);
        if (open?.lang === 'file' && open.path) {
            return (`Continue the open \`\`\`file\`\`\` block for path: ${open.path}\n` +
                `- Do NOT start a new fenced block header.\n` +
                `- Continue exactly from the next character after your last output.\n` +
                `- When the file is complete, close the fence with \`\`\`.\n` +
                `- Do not repeat any earlier text.`);
        }
        if (open?.lang) {
            return (`Continue the open \`\`\`${open.lang}\`\`\` block.\n` +
                `- Do NOT restart it.\n` +
                `- Continue exactly from the next character after your last output.\n` +
                `- Close the fence with \`\`\` when done.\n` +
                `- Do not repeat any earlier text.`);
        }
        return (`Continue exactly where you left off.\n` +
            `- Do not repeat any earlier content.\n` +
            `- If you output fenced blocks (\`\`\`file\`\`\`, \`\`\`edit\`\`\`), make sure each block is complete and properly closed.\n` +
            `- Keep going until the task is complete.`);
    }
    _getOpenFenceInfo(text) {
        const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
        let openLang = null;
        let openPath = undefined;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.startsWith('```'))
                continue;
            if (openLang === null) {
                openLang = line.slice(3).trim() || 'text';
                openPath = undefined;
                if ((openLang === 'file' || openLang === 'edit' || openLang === 'delete') && i + 1 < lines.length) {
                    const next = lines[i + 1].trim();
                    if (next.toLowerCase().startsWith('path:'))
                        openPath = next.slice(5).trim();
                }
            }
            else {
                openLang = null;
                openPath = undefined;
            }
        }
        return openLang ? { lang: openLang, path: openPath } : null;
    }
    async _insertCodeToEditor(code) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.edit(editBuilder => {
                editBuilder.replace(editor.selection, code);
            });
            vscode.window.showInformationMessage('Code inserted into editor!');
        }
        else {
            // Open new document with code
            const doc = await vscode.workspace.openTextDocument({ content: code });
            vscode.window.showTextDocument(doc);
        }
    }
    async sendMessageFromCommand(prompt, label) {
        if (!this._view)
            return;
        this._sendToWebview({ type: 'commandMessage', text: prompt, label });
        await this._handleUserMessage(prompt);
    }
    clearHistory() {
        this._history = [];
        this._sendToWebview({ type: 'clearHistory' });
        vscode.window.showInformationMessage('Azure Codex: Chat history cleared.');
    }
    async undoLastApply() {
        await this._undoLastApply();
    }
    _sendToWebview(message) {
        this._view?.webview.postMessage(message);
    }
    async _buildContextMessages(queryText) {
        const config = vscode.workspace.getConfiguration('azureCodex');
        const includeContext = config.get('includeWorkspaceContext', true);
        if (!includeContext)
            return [];
        const maxChars = config.get('contextMaxChars', 20000);
        const includeFileList = config.get('includeFileList', true);
        const includeActiveFile = config.get('includeActiveFile', true);
        const includeRootDocs = config.get('includeRootDocs', true);
        const pinnedMaxChars = config.get('pinnedContextMaxChars', 20000);
        const semanticEnabled = config.get('semanticIndexEnabled', true);
        const semanticMaxChars = config.get('semanticMaxChars', 12000);
        const semanticTopK = config.get('semanticTopK', 6);
        const memoryText = this._deps?.memoryStore?.buildContext(4000) || '';
        const chunks = [];
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length) {
            chunks.push(`Workspace folders:\n${folders.map((f) => `- ${f.name} (${f.uri.fsPath})`).join('\n')}`);
        }
        if (includeFileList) {
            const files = await this._getWorkspaceFileList();
            if (files.length) {
                chunks.push(`Project file list (paths relative to workspace root):\n${files.map((p) => `- ${p}`).join('\n')}`);
            }
        }
        if (includeRootDocs) {
            const maybeReadme = await this._tryReadWorkspaceFile('README.md', 6000);
            if (maybeReadme)
                chunks.push(maybeReadme);
            const maybePackage = await this._tryReadWorkspaceFile('package.json', 6000);
            if (maybePackage)
                chunks.push(maybePackage);
        }
        if (includeActiveFile) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const rel = this._relPath(editor.document.uri);
                const lang = editor.document.languageId;
                const text = editor.document.getText();
                chunks.push(`Active file (${rel}) [${lang}]:\n` + this._truncate(text, 8000));
            }
        }
        if (memoryText) {
            chunks.push(memoryText);
        }
        // @mentions: allow users to pull specific files into context inline, e.g. "@src/app.ts".
        if (queryText && queryText.includes('@')) {
            const mentioned = this._extractMentionedPaths(queryText);
            if (mentioned.length) {
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length) {
                    const parts = [];
                    for (const p of mentioned.slice(0, 10)) {
                        if (this._looksSensitive(p))
                            continue;
                        const uri = vscode.Uri.joinPath(folders[0].uri, p);
                        try {
                            const bytes = await vscode.workspace.fs.readFile(uri);
                            const txt = Buffer.from(bytes).toString('utf8');
                            parts.push(`File (@${p}):\n${this._truncate(txt, 6000)}`);
                        }
                        catch {
                            parts.push(`File (@${p}):\n[missing/unreadable]`);
                        }
                    }
                    if (parts.length)
                        chunks.push(`Mentioned files:\n${parts.join('\n\n')}`);
                }
            }
        }
        if (semanticEnabled && this._deps?.semanticIndex && queryText && queryText.trim()) {
            try {
                const hits = await this._deps.semanticIndex.search(queryText, { topK: semanticTopK, maxChars: semanticMaxChars });
                if (hits.length) {
                    const snippet = hits
                        .map((h) => `File (${h.path}:${h.startLine}):\n` +
                        this._truncate(h.text, 2500))
                        .join('\n\n');
                    chunks.push(`Relevant code snippets (semantic search):\n${snippet}`);
                }
            }
            catch {
                // ignore semantic failures
            }
        }
        const pinned = this._buildPinnedContext(pinnedMaxChars);
        if (pinned)
            chunks.push(pinned);
        let context = chunks.filter(Boolean).join('\n\n---\n\n');
        context = this._truncate(context, maxChars);
        if (!context.trim())
            return [];
        return [
            {
                role: 'system',
                content: `Workspace context (auto-included). Use this to answer questions and propose code changes. ` +
                    `If you need a specific file that isn't shown, ask the user to open/paste it, or provide a targeted request for that file.\n\n${context}`
            }
        ];
    }
    _extractMentionedPaths(text) {
        const out = [];
        const re = /@([A-Za-z0-9_./-]{1,200})/g;
        let m;
        while ((m = re.exec(String(text || '')))) {
            const p = m[1];
            if (!p)
                continue;
            if (p.startsWith('/') || p.startsWith('~') || p.startsWith('..') || p.includes('\\') || p.includes(':'))
                continue;
            // skip obvious emails
            if (p.includes('@'))
                continue;
            out.push(p);
        }
        return Array.from(new Set(out));
    }
    async _getWorkspaceFileList() {
        const now = Date.now();
        if (this._lastFileList && now - this._lastFileList.at < 30000)
            return this._lastFileList.items;
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length)
            return [];
        const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
        const uris = await vscode.workspace.findFiles('**/*', exclude, 250);
        const items = uris
            .map((u) => this._relPath(u))
            .filter((p) => !!p && !p.endsWith('/'))
            .sort((a, b) => a.localeCompare(b));
        this._lastFileList = { at: now, items };
        return items;
    }
    async _tryReadWorkspaceFile(relPath, maxChars) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length)
            return null;
        const uri = vscode.Uri.joinPath(folders[0].uri, relPath);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            return `File (${relPath}):\n` + this._truncate(text, maxChars);
        }
        catch {
            return null;
        }
    }
    _truncate(text, maxChars) {
        if (text.length <= maxChars)
            return text;
        return text.slice(0, maxChars) + `\n\n[truncated to ${maxChars} chars]`;
    }
    _relPath(uri) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length)
            return uri.fsPath;
        const folder = folders[0];
        const root = folder.uri.fsPath.replace(/\/$/, '');
        const full = uri.fsPath;
        if (full.startsWith(root)) {
            const rel = full.slice(root.length).replace(/^\/+/, '');
            return rel || uri.fsPath;
        }
        return uri.fsPath;
    }
    async _applyFileBlock(lang, code) {
        const ops = [];
        const res = await this._applyFileBlockInternal(lang, code, { confirm: true, collectUndoOps: ops });
        if (!res)
            return;
        if (ops.length) {
            this._pushUndoBatch({ label: `Apply ${res.path}`, ops });
            const picked = await vscode.window.showInformationMessage(`Azure Codex: Applied ${res.path}`, 'Undo');
            if (picked === 'Undo')
                await this._undoLastApply();
        }
    }
    async _applyFileBlockInternal(lang, code, opts) {
        const normalizedLang = String(lang || '').trim().toLowerCase();
        if (normalizedLang !== 'file' && normalizedLang !== 'delete' && normalizedLang !== 'edit') {
            vscode.window.showWarningMessage(`Unsupported apply block type: ${lang}`);
            return null;
        }
        const parsed = this._parseFileBlock(code);
        if (!parsed) {
            vscode.window.showErrorMessage(`Could not parse ${normalizedLang} block. Expected first line like: path: src/file.ts`);
            return null;
        }
        const { path, content } = parsed;
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return null;
        }
        const targetUri = vscode.Uri.joinPath(folders[0].uri, path);
        if (normalizedLang === 'delete') {
            if (opts.confirm) {
                const confirm = await vscode.window.showWarningMessage(`Delete file ${path}?`, { modal: true }, 'Delete');
                if (confirm !== 'Delete')
                    return null;
            }
            try {
                const prevBytes = await vscode.workspace.fs.readFile(targetUri);
                const prevContent = Buffer.from(prevBytes).toString('utf8');
                opts.collectUndoOps?.push({ path, prevExists: true, prevContent });
                await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: true });
                if (opts.confirm)
                    vscode.window.showInformationMessage(`Deleted ${path}`);
            }
            catch (e) {
                vscode.window.showErrorMessage(`Failed to delete ${path}: ${e?.message || String(e)}`);
                return null;
            }
            return { kind: 'delete', path };
        }
        // For `file`: overwrite with provided content.
        // For `edit`: apply search/replace blocks to existing content.
        const dir = path.split('/').slice(0, -1).join('/');
        if (dir) {
            try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, dir));
            }
            catch {
                // ignore
            }
        }
        try {
            let prevExists = false;
            let prevContent = '';
            try {
                const prevBytes = await vscode.workspace.fs.readFile(targetUri);
                prevExists = true;
                prevContent = Buffer.from(prevBytes).toString('utf8');
            }
            catch {
                prevExists = false;
                prevContent = '';
            }
            let nextContent = content;
            if (normalizedLang === 'edit') {
                if (!prevExists) {
                    vscode.window.showErrorMessage(`Cannot apply edits: ${path} does not exist yet. Use a \`\`\`file\`\`\` block to create it.`);
                    return null;
                }
                const applied = this._applySearchReplaceEdits(prevContent, content);
                if (!applied.ok) {
                    vscode.window.showErrorMessage(`Failed to apply edits to ${path}: ${applied.error}`);
                    return null;
                }
                nextContent = applied.updated;
                if (opts.confirm) {
                    const picked = await vscode.window.showWarningMessage(`Apply ${applied.count} edit(s) to ${path}?`, { modal: true }, 'Preview', 'Apply');
                    if (!picked)
                        return null;
                    if (picked === 'Preview') {
                        await this._showDiffPreview(targetUri, prevContent, nextContent, `Azure Codex: Preview edits — ${path}`);
                        const confirmAfter = await vscode.window.showWarningMessage(`Apply edits to ${path}?`, { modal: true }, 'Apply');
                        if (confirmAfter !== 'Apply')
                            return null;
                    }
                }
            }
            else if (opts.confirm) {
                const confirm = await vscode.window.showWarningMessage(`Write file ${path}? This will overwrite it if it already exists.`, { modal: true }, 'Write');
                if (confirm !== 'Write')
                    return null;
            }
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(nextContent, 'utf8'));
            opts.collectUndoOps?.push({ path, prevExists, prevContent });
            if (opts.confirm) {
                const doc = await vscode.workspace.openTextDocument(targetUri);
                await vscode.window.showTextDocument(doc, { preview: false });
                vscode.window.showInformationMessage(`${normalizedLang === 'edit' ? 'Edited' : 'Wrote'} ${path}`);
            }
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to write ${path}: ${e?.message || String(e)}`);
            return null;
        }
        return { kind: 'file', path };
    }
    _parseFileBlock(code) {
        const lines = String(code || '').replace(/\r\n/g, '\n').split('\n');
        const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
        if (firstNonEmptyIdx === -1)
            return null;
        const first = lines[firstNonEmptyIdx].trim();
        const match = first.match(/^path:\s*(.+)\s*$/i);
        if (!match)
            return null;
        const rawPath = match[1].trim().replace(/^["']|["']$/g, '');
        if (!rawPath ||
            rawPath.startsWith('/') ||
            rawPath.startsWith('~') ||
            rawPath.startsWith('..') ||
            rawPath.includes('\\') ||
            rawPath.includes(':'))
            return null;
        const content = lines.slice(firstNonEmptyIdx + 1).join('\n');
        return { path: rawPath, content };
    }
    _buildPinnedContext(maxChars) {
        const items = [];
        if (this._pinnedTextFiles.size) {
            items.push(`Pinned text files (added via + / Fetch):\n` +
                Array.from(this._pinnedTextFiles.entries())
                    .map(([p, c]) => `File (${p}):\n${this._truncate(c, 8000)}`)
                    .join('\n\n'));
        }
        if (this._pinnedImages.size) {
            items.push(`Pinned images (sent with your next message as image attachments):\n` +
                Array.from(this._pinnedImages.keys())
                    .map((p) => `- ${p}`)
                    .join('\n'));
        }
        const combined = items.join('\n\n');
        return this._truncate(combined, maxChars);
    }
    _buildUserContent(text) {
        if (!this._pinnedImages.size)
            return text;
        const parts = [{ type: 'input_text', text }];
        for (const [path, dataUrl] of this._pinnedImages.entries()) {
            parts.push({ type: 'input_text', text: `Attached image: ${path}` });
            parts.push({ type: 'input_image', image_url: dataUrl });
        }
        return parts;
    }
    async _pickAttachments() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Add to Context',
            filters: {
                Documents: ['pdf', 'csv', 'xlsx', 'xls', 'docx', 'pptx'],
                'Text / Code': [
                    'txt',
                    'md',
                    'json',
                    'yaml',
                    'yml',
                    'toml',
                    'ini',
                    'xml',
                    'html',
                    'css',
                    'js',
                    'ts',
                    'tsx',
                    'jsx',
                    'py',
                    'java',
                    'cs',
                    'go',
                    'rs',
                    'rb',
                    'php',
                    'sh',
                    'ps1'
                ],
                Images: ['png', 'jpg', 'jpeg', 'webp', 'gif']
            }
        });
        if (!picked || !picked.length)
            return;
        for (const uri of picked) {
            const rel = this._relPath(uri);
            if (this._looksSensitive(rel)) {
                vscode.window.showWarningMessage(`Skipped sensitive file: ${rel}`);
                continue;
            }
            const ext = rel.split('.').pop()?.toLowerCase() || '';
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
                const maxBytes = vscode.workspace.getConfiguration('azureCodex').get('attachmentsMaxBytes', 2000000);
                if (bytes.byteLength > maxBytes) {
                    vscode.window.showWarningMessage(`Skipped large image (${Math.round(bytes.byteLength / 1024)}KB): ${rel}`);
                    continue;
                }
                const mime = ext === 'jpg' || ext === 'jpeg'
                    ? 'image/jpeg'
                    : ext === 'png'
                        ? 'image/png'
                        : ext === 'webp'
                            ? 'image/webp'
                            : ext === 'gif'
                                ? 'image/gif'
                                : 'application/octet-stream';
                const base64 = Buffer.from(bytes).toString('base64');
                this._pinnedImages.set(rel, `data:${mime};base64,${base64}`);
                continue;
            }
            const extracted = await this._attachmentToText(rel, bytes);
            if (!extracted) {
                vscode.window.showWarningMessage(`Unsupported attachment type (skipped): ${rel}`);
                continue;
            }
            this._pinnedTextFiles.set(rel, this._truncate(extracted, 200000));
        }
        this._sendContextStatus();
        vscode.window.showInformationMessage('Added selected files to context.');
    }
    async _attachmentToText(relPath, bytes) {
        const ext = relPath.split('.').pop()?.toLowerCase() || '';
        const buf = Buffer.from(bytes);
        const textLike = new Set([
            'txt',
            'md',
            'csv',
            'json',
            'yaml',
            'yml',
            'toml',
            'ini',
            'xml',
            'html',
            'css',
            'js',
            'ts',
            'tsx',
            'jsx',
            'py',
            'java',
            'cs',
            'go',
            'rs',
            'rb',
            'php',
            'sh',
            'ps1'
        ]);
        if (textLike.has(ext)) {
            const text = buf.toString('utf8');
            return `Attached file (text): ${relPath}\n\n${text}`;
        }
        if (ext === 'pdf') {
            try {
                const res = await (0, pdf_parse_1.default)(buf);
                const text = String(res?.text || '').trim();
                return `Attached file (pdf -> text): ${relPath}\n\n${text}`;
            }
            catch (e) {
                vscode.window.showWarningMessage(`Failed to extract PDF text: ${relPath} (${e?.message || String(e)})`);
                return null;
            }
        }
        if (ext === 'xlsx' || ext === 'xls') {
            try {
                const wb = XLSX.read(buf, { type: 'buffer' });
                const names = (wb.SheetNames || []).slice(0, 3);
                const parts = [`Attached file (excel -> csv preview): ${relPath}`];
                for (const name of names) {
                    const sheet = wb.Sheets[name];
                    if (!sheet)
                        continue;
                    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
                    parts.push(`--- Sheet: ${name} ---\n${csv.trim()}`);
                }
                return parts.join('\n\n');
            }
            catch (e) {
                vscode.window.showWarningMessage(`Failed to read Excel file: ${relPath} (${e?.message || String(e)})`);
                return null;
            }
        }
        if (ext === 'docx') {
            try {
                const res = await mammoth.extractRawText({ buffer: buf });
                const text = String(res?.value || '').trim();
                return `Attached file (docx -> text): ${relPath}\n\n${text}`;
            }
            catch (e) {
                vscode.window.showWarningMessage(`Failed to extract DOCX text: ${relPath} (${e?.message || String(e)})`);
                return null;
            }
        }
        if (ext === 'pptx') {
            try {
                const zip = await jszip_1.default.loadAsync(buf);
                const slideXmlPaths = Object.keys(zip.files)
                    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
                    .sort((a, b) => a.localeCompare(b));
                const texts = [];
                for (const p of slideXmlPaths.slice(0, 20)) {
                    const xml = await zip.files[p].async('string');
                    const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
                    const slideText = matches
                        .map((m) => m.replace(/^[\s\S]*?>/, '').replace(/<\/a:t>[\s\S]*$/, ''))
                        .map((s) => s
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'"))
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (slideText)
                        texts.push(`[${p}] ${slideText}`);
                }
                return `Attached file (pptx -> text): ${relPath}\n\n${texts.join('\n')}`.trim();
            }
            catch (e) {
                vscode.window.showWarningMessage(`Failed to extract PPTX text: ${relPath} (${e?.message || String(e)})`);
                return null;
            }
        }
        return null;
    }
    async _removeContextItem(kind, label) {
        const k = String(kind || '').toLowerCase();
        const l = String(label || '');
        if (k === 'text')
            this._pinnedTextFiles.delete(l);
        if (k === 'image')
            this._pinnedImages.delete(l);
        this._sendContextStatus();
    }
    async _fetchRequestedFiles(code) {
        const requested = this._parseRequestedPaths(code);
        if (!requested.length) {
            vscode.window.showErrorMessage('No paths found in request block.');
            return;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }
        const added = [];
        for (const relPath of requested) {
            if (this._looksSensitive(relPath))
                continue;
            const uri = vscode.Uri.joinPath(folders[0].uri, relPath);
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = Buffer.from(bytes).toString('utf8');
                this._pinnedTextFiles.set(relPath, this._truncate(text, 200000));
                added.push(relPath);
            }
            catch {
                // ignore missing
            }
        }
        this._sendContextStatus();
        if (!added.length) {
            vscode.window.showWarningMessage('No requested files could be added (missing or blocked).');
            return;
        }
        await this._handleUserMessage('Continue. You now have the requested files in pinned context. Do not repeat the file contents; just proceed with the task.', { displayText: `Fetched ${added.length} file(s) into context. Continue.` });
    }
    _parseRequestedPaths(code) {
        const text = String(code || '').replace(/\r\n/g, '\n').trim();
        if (!text)
            return [];
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const out = [];
        for (const line of lines) {
            if (line.toLowerCase() === 'paths:' || line.toLowerCase() === 'path:' || line.toLowerCase().startsWith('#'))
                continue;
            const m = line.match(/^-\s*(.+)$/);
            const candidate = (m ? m[1] : line).trim().replace(/^["']|["']$/g, '');
            if (!candidate)
                continue;
            if (candidate.startsWith('/') || candidate.startsWith('~') || candidate.startsWith('..') || candidate.includes('\\') || candidate.includes(':'))
                continue;
            out.push(candidate);
        }
        return Array.from(new Set(out)).slice(0, 20);
    }
    _looksSensitive(relPath) {
        const p = relPath.toLowerCase();
        return (p.endsWith('.env') ||
            p.includes('/.env') ||
            p.includes('id_rsa') ||
            p.endsWith('.pem') ||
            p.endsWith('.key') ||
            p.endsWith('.pfx') ||
            p.endsWith('.p12') ||
            p.includes('node_modules/') ||
            p.includes('/.git/'));
    }
    async _sendContextStatus() {
        if (!this._view)
            return;
        const config = vscode.workspace.getConfiguration('azureCodex');
        const includeContext = config.get('includeWorkspaceContext', true);
        const includeFileList = config.get('includeFileList', true);
        const includeActiveFile = config.get('includeActiveFile', true);
        const includeRootDocs = config.get('includeRootDocs', true);
        const autoApplyFileChanges = config.get('autoApplyFileChanges', false);
        const autoContinueOnTruncation = config.get('autoContinueOnTruncation', true);
        const agentEnabled = config.get('agentEnabled', false);
        const chatModelMode = config.get('chatModelMode', 'smart');
        const memoryEnabled = config.get('memoryEnabled', true);
        let fileCount = 0;
        let activeFile = null;
        if (includeFileList) {
            try {
                fileCount = (await this._getWorkspaceFileList()).length;
            }
            catch {
                fileCount = 0;
            }
        }
        if (includeActiveFile && vscode.window.activeTextEditor) {
            activeFile = this._relPath(vscode.window.activeTextEditor.document.uri);
        }
        this._sendToWebview({
            type: 'contextStatus',
            status: {
                auto: {
                    enabled: includeContext,
                    includeFileList,
                    includeActiveFile,
                    includeRootDocs,
                    autoApplyFileChanges,
                    autoContinueOnTruncation,
                    agentEnabled,
                    chatModelMode,
                    memoryEnabled,
                    fileCount,
                    activeFile
                },
                pinned: {
                    textFiles: Array.from(this._pinnedTextFiles.keys()).sort((a, b) => a.localeCompare(b)),
                    images: Array.from(this._pinnedImages.keys()).sort((a, b) => a.localeCompare(b))
                }
            }
        });
    }
    async _setConfig(key, value) {
        const k = String(key || '').trim();
        const allowed = {
            autoApplyFileChanges: 'azureCodex.autoApplyFileChanges',
            autoContinueOnTruncation: 'azureCodex.autoContinueOnTruncation',
            agentEnabled: 'azureCodex.agentEnabled',
            chatModelMode: 'azureCodex.chatModelMode',
            semanticIndexEnabled: 'azureCodex.semanticIndexEnabled',
            autocompleteEnabled: 'azureCodex.autocompleteEnabled',
            memoryEnabled: 'azureCodex.memoryEnabled'
        };
        const setting = allowed[k];
        if (!setting) {
            vscode.window.showWarningMessage(`Unsupported setting: ${k}`);
            return;
        }
        try {
            await vscode.workspace.getConfiguration().update(setting, value, vscode.ConfigurationTarget.Global);
            await this._sendContextStatus();
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to update setting ${k}: ${e?.message || String(e)}`);
        }
    }
    _stopGeneration() {
        if (!this._currentAbort)
            return;
        try {
            this._currentAbort.abort();
        }
        catch {
            // ignore
        }
        finally {
            this._currentAbort = undefined;
        }
    }
    async _autoApplyIfEnabled(assistantText) {
        const config = vscode.workspace.getConfiguration('azureCodex');
        const enabled = config.get('autoApplyFileChanges', false);
        if (!enabled)
            return;
        const blocks = this._extractFencedBlocks(assistantText);
        const actionableFiles = blocks.filter((b) => b.lang === 'file' || b.lang === 'edit');
        const hasDeletes = blocks.some((b) => b.lang === 'delete');
        if (!actionableFiles.length) {
            if (hasDeletes) {
                vscode.window.showInformationMessage('Azure Codex: Auto-apply skips `delete` blocks. Click Apply on the delete block to confirm.');
            }
            return;
        }
        const applied = [];
        const ops = [];
        for (const b of actionableFiles) {
            const res = await this._applyFileBlockInternal(b.lang, b.code, { confirm: false, collectUndoOps: ops });
            if (res)
                applied.push(res);
        }
        if (!applied.length)
            return;
        if (ops.length) {
            const label = applied.length === 1
                ? `Auto-apply ${applied[0].path}`
                : `Auto-apply ${applied.length} change(s)`;
            this._pushUndoBatch({ label, ops });
        }
        if (applied.length === 1 && applied[0].kind === 'file') {
            try {
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length) {
                    const uri = vscode.Uri.joinPath(folders[0].uri, applied[0].path);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, { preview: false });
                }
            }
            catch {
                // ignore
            }
            const picked = await vscode.window.showInformationMessage(`Azure Codex: Updated ${applied[0].path}`, 'Undo');
            if (picked === 'Undo')
                await this._undoLastApply();
            return;
        }
        const picked = await vscode.window.showInformationMessage(`Azure Codex: Applied ${applied.length} change(s) (${applied.slice(0, 3).map((a) => a.path).join(', ')}${applied.length > 3 ? ', ...' : ''}).`, 'Undo');
        if (picked === 'Undo')
            await this._undoLastApply();
    }
    async _runAgent(userText) {
        if (!this._view)
            return;
        const config = vscode.workspace.getConfiguration('azureCodex');
        const maxSteps = Math.max(1, Math.min(20, config.get('agentMaxSteps', 6)));
        const allowShell = config.get('agentAllowShellCommands', false);
        const defaultDeployment = config.get('deploymentName', 'gpt-5-2-codex-max');
        const model = this._deps?.modelRouter?.getAgentDeployment(defaultDeployment) || defaultDeployment;
        this._sendToWebview({ type: 'assistantStart' });
        const exec = (0, util_1.promisify)(child_process_1.exec);
        const folders = vscode.workspace.workspaceFolders;
        const root = folders && folders.length ? folders[0].uri.fsPath : process.cwd();
        const rootUri = folders && folders.length ? folders[0].uri : vscode.Uri.file(root);
        const session = new agentSession_1.AgentSession(rootUri);
        const toolHelp = `You are running in AGENT MODE. You can use tools to read/search files, apply edits, run commands, and use git.\n` +
            `To call a tool, output a fenced block:\n` +
            '```tool\n' +
            '{"name":"read_file","args":{"path":"src/app.ts"}}\n' +
            '```\n' +
            `Available tools:\n` +
            `- list_files { glob?, max? }\n` +
            `- read_file { path, maxChars? }\n` +
            `- search_files { query, glob?, maxResults? }\n` +
            `- write_file { path, content } (staged; will be reviewed)\n` +
            `- apply_edit { path, edits } where edits is the inside of an \`edit\` block (SEARCH/REPLACE)\n` +
            `- run_command { command } (requires user confirmation; may be disabled)\n` +
            `- git_status {}\n` +
            `- git_diff { args? } (args like "--staged" or "path")\n` +
            `- fetch_url { url } (fetch external docs)\n` +
            `- remember { key, value }\n` +
            `- forget { key }\n` +
            `Rules:\n` +
            `- Prefer apply_edit (diff-based) over write_file.\n` +
            `- File changes are staged; at the end ask user to review/apply.\n` +
            `- Keep tool calls minimal. After tools, respond with a short summary and "Next improvements".`;
        const baseContext = await this._buildContextMessages(userText);
        const memory = this._deps?.memoryStore;
        let scratch = [
            ...baseContext,
            { role: 'system', content: toolHelp }
        ];
        // keep recent chat history
        scratch.push(...this._history.slice(-8));
        let accumulatedDisplay = '';
        for (let step = 1; step <= maxSteps; step++) {
            session.beginStep(`Step ${step}`);
            const assistantText = await this._client.chatToText(scratch, step === 1 ? userText : 'Continue.', { model });
            const { display, tools } = this._extractToolCallsAndStrip(assistantText);
            if (display.trim()) {
                const chunk = `\n\n${display.trim()}\n`;
                accumulatedDisplay += chunk;
                this._sendToWebview({ type: 'assistantToken', token: chunk });
            }
            // Apply file/edit blocks opportunistically if auto-apply is enabled.
            // In agent mode, we stage via tools; we still allow auto-apply of explicit blocks if present.
            await this._autoApplyIfEnabled(assistantText);
            if (!tools.length)
                break;
            const toolResults = [];
            for (const call of tools) {
                const name = String(call?.name || '');
                const args = call?.args ?? {};
                try {
                    switch (name) {
                        case 'list_files': {
                            const glob = typeof args.glob === 'string' ? args.glob : '**/*';
                            const max = Math.max(1, Math.min(500, Number(args.max ?? 50)));
                            const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
                            const uris = await vscode.workspace.findFiles(glob, exclude, max);
                            toolResults.push(`list_files:\n${uris.map((u) => this._relPath(u)).join('\n')}`);
                            break;
                        }
                        case 'read_file': {
                            const p = String(args.path || '').trim();
                            const maxChars = Math.max(1000, Math.min(200000, Number(args.maxChars ?? 50000)));
                            const txt = await session.readFile(p, maxChars);
                            toolResults.push(`read_file (${p}):\n${txt ?? '[missing or unreadable]'}`);
                            break;
                        }
                        case 'search_files': {
                            const query = String(args.query || '').trim();
                            const glob = typeof args.glob === 'string' ? args.glob : '**/*';
                            const maxResults = Math.max(1, Math.min(200, Number(args.maxResults ?? 50)));
                            const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
                            const uris = await vscode.workspace.findFiles(glob, exclude, 500);
                            const hits = [];
                            const ioConcurrency = 10;
                            for (let i = 0; i < uris.length && hits.length < maxResults; i += ioConcurrency) {
                                const batch = uris.slice(i, i + ioConcurrency);
                                const loaded = await Promise.all(batch.map(async (uri) => {
                                    try {
                                        const rel = this._relPath(uri);
                                        if (this._looksSensitive(rel))
                                            return null;
                                        const stat = await vscode.workspace.fs.stat(uri);
                                        if (stat.size > 400000)
                                            return null;
                                        const staged = (await session.readFile(rel, 500000)) ?? null;
                                        if (staged !== null)
                                            return { rel, text: staged };
                                        const bytes = await vscode.workspace.fs.readFile(uri);
                                        const text = Buffer.from(bytes).toString('utf8');
                                        return { rel, text };
                                    }
                                    catch {
                                        return null;
                                    }
                                }));
                                for (const file of loaded) {
                                    if (!file)
                                        continue;
                                    if (hits.length >= maxResults)
                                        break;
                                    const lines = file.text.replace(/\r\n/g, '\n').split('\n');
                                    for (let ln = 0; ln < lines.length && hits.length < maxResults; ln++) {
                                        if (lines[ln].includes(query)) {
                                            hits.push(`${file.rel}:${ln + 1}: ${lines[ln].trim().slice(0, 200)}`);
                                        }
                                    }
                                }
                            }
                            toolResults.push(`search_files (${query}):\n${hits.join('\n') || '[no matches]'}`);
                            break;
                        }
                        case 'write_file': {
                            const p = String(args.path || '').trim();
                            const content = String(args.content ?? '');
                            await session.stageWrite(p, content);
                            toolResults.push(`write_file: staged ${p}`);
                            break;
                        }
                        case 'apply_edit': {
                            const p = String(args.path || '').trim();
                            const edits = String(args.edits ?? '');
                            const current = await session.readFile(p, 2000000);
                            if (current === null)
                                throw new Error('File missing or unreadable.');
                            const applied = this._applySearchReplaceEdits(current, edits);
                            if (!applied.ok)
                                throw new Error(applied.error);
                            await session.stageWrite(p, applied.updated);
                            toolResults.push(`apply_edit: staged edits for ${p} (${applied.count} block(s))`);
                            break;
                        }
                        case 'run_command': {
                            if (!allowShell) {
                                toolResults.push('run_command: blocked (agentAllowShellCommands=false)');
                                break;
                            }
                            const command = String(args.command || '').trim();
                            const confirm = await vscode.window.showWarningMessage(`Azure Codex Agent wants to run:\n${command}`, { modal: true }, 'Run');
                            if (confirm !== 'Run') {
                                toolResults.push(`run_command: canceled (${command})`);
                                break;
                            }
                            const res = await exec(command, { cwd: root, timeout: 120000, maxBuffer: 2000000 });
                            const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
                            toolResults.push(`run_command (${command}):\n${out.slice(0, 20000)}`);
                            break;
                        }
                        case 'fetch_url': {
                            const url = String(args.url || '').trim();
                            const fetched = await this._safeFetchUrl(url);
                            toolResults.push(`fetch_url (${url}):\n${fetched}`);
                            break;
                        }
                        case 'git_status': {
                            const res = await exec('git status --porcelain=v1 -b', { cwd: root, timeout: 30000, maxBuffer: 500000 });
                            toolResults.push(`git_status:\n${(res.stdout || '').trim()}`);
                            break;
                        }
                        case 'git_diff': {
                            const extra = typeof args.args === 'string' ? args.args : '';
                            const res = await exec(`git diff ${extra}`.trim(), { cwd: root, timeout: 30000, maxBuffer: 2000000 });
                            toolResults.push(`git_diff ${extra}:\n${(res.stdout || '').slice(0, 40000)}`);
                            break;
                        }
                        case 'remember': {
                            if (!memory) {
                                toolResults.push('remember: unavailable');
                                break;
                            }
                            await memory.remember(String(args.key || ''), String(args.value || ''));
                            toolResults.push(`remember: saved ${String(args.key || '')}`);
                            break;
                        }
                        case 'forget': {
                            if (!memory) {
                                toolResults.push('forget: unavailable');
                                break;
                            }
                            await memory.forget(String(args.key || ''));
                            toolResults.push(`forget: removed ${String(args.key || '')}`);
                            break;
                        }
                        default:
                            toolResults.push(`unknown_tool: ${name}`);
                    }
                }
                catch (e) {
                    toolResults.push(`${name} failed: ${e?.message || String(e)}`);
                }
            }
            const resultMsg = `Tool results (step ${step}):\n\n${toolResults.join('\n\n---\n\n')}`;
            this._sendToWebview({ type: 'assistantToken', token: `\n\n${resultMsg}\n` });
            scratch.push({ role: 'assistant', content: assistantText });
            scratch.push({ role: 'user', content: resultMsg });
        }
        this._sendToWebview({ type: 'assistantDone' });
        // Save a compact version to history so future turns have continuity.
        this._history.push({ role: 'user', content: userText });
        this._history.push({ role: 'assistant', content: accumulatedDisplay.trim() || '[agent run completed]' });
        if (this._history.length > 20)
            this._history = this._history.slice(-20);
        const staged = session.listStaged();
        if (staged.length) {
            const picked = await vscode.window.showInformationMessage(`Azure Codex Agent staged ${staged.length} file(s). Review before applying.`, 'Open Review Panel', 'Review (Quick)');
            if (picked === 'Open Review Panel') {
                await this._openAgentReviewPanel(session);
            }
            else if (picked === 'Review (Quick)') {
                await this._reviewAndMaybeApplyAgentChanges(session);
            }
        }
    }
    async _openAgentReviewPanel(session) {
        const staged = session.listStaged();
        if (!staged.length)
            return;
        agentReviewPanel_1.AgentReviewPanel.show({
            extensionUri: this._extensionUri,
            title: `Azure Codex: Agent Review (${staged.length} file(s))`,
            session,
            onApply: async (acceptedPaths) => {
                // Apply only accepted paths
                const filteredSession = session;
                const all = filteredSession.listStaged();
                const acceptSet = new Set(acceptedPaths);
                const keep = all.filter((c) => acceptSet.has(c.path));
                // Temporarily discard other staged changes from apply
                const tmp = new agentSession_1.AgentSession((vscode.workspace.workspaceFolders?.[0]?.uri) ?? vscode.Uri.file(process.cwd()));
                for (const k of keep) {
                    await tmp.stageWrite(k.path, k.nextContent);
                    // keep original prev snapshots
                    const stagedTmp = tmp.listStaged().find((x) => x.path === k.path);
                    if (stagedTmp) {
                        stagedTmp.prevExists = k.prevExists;
                        stagedTmp.prevContent = k.prevContent;
                    }
                }
                await this._applyStagedChanges(tmp, { confirm: false });
            },
            onDiscard: () => session.discardAll()
        });
    }
    async _reviewAndMaybeApplyAgentChanges(session) {
        const staged = session.listStaged();
        if (!staged.length)
            return;
        const items = [
            { label: 'Apply All', description: 'Write all staged changes to disk', action: 'apply' },
            { label: 'Discard All', description: 'Drop all staged changes', action: 'discard' },
            { label: 'Review', kind: vscode.QuickPickItemKind.Separator, action: 'diff' }
        ];
        const checkpoints = session.listCheckpoints();
        if (checkpoints.length > 1) {
            items.push({ label: 'Revert to checkpoint…', description: 'Rollback staged changes to an earlier agent step', action: 'diff', path: '__revert__' });
        }
        items.push(...staged.map((c) => ({ label: c.path, description: 'Open diff preview', action: 'diff', path: c.path })));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Review staged changes' });
        if (!pick)
            return;
        if (pick.action === 'discard') {
            session.discardAll();
            vscode.window.showInformationMessage('Azure Codex Agent: Discarded staged changes.');
            return;
        }
        if (pick.action === 'apply') {
            await this._applyStagedChanges(session, { confirm: true });
            return;
        }
        if (pick.action === 'diff') {
            if (pick.path === '__revert__') {
                const cps = session
                    .listCheckpoints()
                    .slice()
                    .reverse()
                    .map((c) => ({
                    label: `Step ${c.step}`,
                    description: c.label,
                    detail: new Date(c.at).toLocaleString(),
                    step: c.step
                }));
                const chosen = await vscode.window.showQuickPick(cps, { placeHolder: 'Revert staged changes to which step?' });
                if (!chosen)
                    return;
                session.revertToStep(chosen.step);
                vscode.window.showInformationMessage(`Azure Codex Agent: Reverted staged changes to step ${chosen.step}.`);
                // Re-open review after revert
                await this._reviewAndMaybeApplyAgentChanges(session);
                return;
            }
            const ch = staged.find((s) => s.path === pick.path);
            if (!ch)
                return;
            await this._showDiffPreview(ch.uri, ch.prevContent, ch.nextContent, `Azure Codex Agent: ${ch.path}`);
            return;
        }
    }
    async _applyStagedChanges(session, opts) {
        const staged = session.listStaged();
        if (!staged.length)
            return;
        if (opts.confirm) {
            const confirm = await vscode.window.showWarningMessage(`Apply ${staged.length} staged change(s) to your workspace?`, { modal: true }, 'Apply');
            if (confirm !== 'Apply')
                return;
        }
        const ops = [];
        for (const c of staged) {
            const dir = c.path.split('/').slice(0, -1).join('/');
            if (dir) {
                try {
                    const folders = vscode.workspace.workspaceFolders;
                    if (folders && folders.length) {
                        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, dir));
                    }
                }
                catch {
                    // ignore
                }
            }
            await vscode.workspace.fs.writeFile(c.uri, Buffer.from(c.nextContent, 'utf8'));
            ops.push({ path: c.path, prevExists: c.prevExists, prevContent: c.prevContent });
        }
        this._pushUndoBatch({ label: `Agent apply (${staged.length} file(s))`, ops });
        vscode.window.showInformationMessage(`Azure Codex Agent: Applied ${staged.length} file(s).`);
    }
    async _safeFetchUrl(rawUrl) {
        const u = String(rawUrl || '').trim();
        if (!u)
            return '[empty url]';
        let url;
        try {
            url = new URL(u);
        }
        catch {
            return '[invalid url]';
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return '[blocked protocol]';
        const host = url.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0')
            return '[blocked host]';
        if (host.endsWith('.local'))
            return '[blocked host]';
        if (host === '169.254.169.254')
            return '[blocked host]';
        try {
            const res = await fetch(url.toString(), { method: 'GET' });
            const text = await res.text();
            const clipped = text.slice(0, 60000);
            return `HTTP ${res.status}\n${clipped}`;
        }
        catch (e) {
            return `[fetch failed] ${e?.message || String(e)}`;
        }
    }
    _extractToolCallsAndStrip(text) {
        const blocks = this._extractFencedBlocks(text);
        const tools = [];
        for (const b of blocks) {
            if (b.lang !== 'tool')
                continue;
            try {
                const parsed = JSON.parse(b.code);
                if (parsed && typeof parsed.name === 'string')
                    tools.push({ name: parsed.name, args: parsed.args ?? {} });
            }
            catch {
                // ignore
            }
        }
        let display = String(text || '');
        // remove tool blocks from display
        display = display.replace(/```tool[\s\S]*?```/g, '').trim();
        return { display, tools };
    }
    _extractFencedBlocks(text) {
        const out = [];
        const s = String(text || '');
        const fence = '```';
        let i = 0;
        while (i < s.length) {
            const start = s.indexOf(fence, i);
            if (start === -1)
                break;
            const langEnd = s.indexOf('\n', start + fence.length);
            if (langEnd === -1)
                break;
            const lang = s.slice(start + fence.length, langEnd).trim().toLowerCase();
            const end = s.indexOf(fence, langEnd + 1);
            if (end === -1)
                break;
            const code = s.slice(langEnd + 1, end).replace(/\r\n/g, '\n').trim();
            out.push({ lang, code });
            i = end + fence.length;
        }
        return out;
    }
    _applySearchReplaceEdits(original, editBlockContent) {
        const lines = String(editBlockContent || '').replace(/\r\n/g, '\n').split('\n');
        const blocks = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trimEnd();
            if (line.trim() !== '<<<<<<< SEARCH') {
                i++;
                continue;
            }
            i++;
            const searchLines = [];
            while (i < lines.length && lines[i].trim() !== '=======') {
                searchLines.push(lines[i]);
                i++;
            }
            if (i >= lines.length || lines[i].trim() !== '=======')
                return { ok: false, error: 'Malformed edit block (missing =======).' };
            i++;
            const replaceLines = [];
            while (i < lines.length && lines[i].trim() !== '>>>>>>> REPLACE') {
                replaceLines.push(lines[i]);
                i++;
            }
            if (i >= lines.length || lines[i].trim() !== '>>>>>>> REPLACE')
                return { ok: false, error: 'Malformed edit block (missing >>>>>>> REPLACE).' };
            i++;
            blocks.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
        }
        if (!blocks.length)
            return { ok: false, error: 'No SEARCH/REPLACE blocks found.' };
        let updated = String(original || '').replace(/\r\n/g, '\n');
        let count = 0;
        for (const b of blocks) {
            const search = b.search;
            const replace = b.replace;
            const idx = updated.indexOf(search);
            if (idx === -1)
                return { ok: false, error: 'SEARCH block not found in file.' };
            if (updated.indexOf(search, idx + 1) !== -1)
                return { ok: false, error: 'SEARCH block is not unique in file.' };
            updated = updated.slice(0, idx) + replace + updated.slice(idx + search.length);
            count++;
        }
        return { ok: true, updated, count };
    }
    async _showDiffPreview(targetUri, before, after, title) {
        try {
            const originalDoc = await vscode.workspace.openTextDocument({ content: before });
            const modifiedDoc = await vscode.workspace.openTextDocument({ content: after });
            await vscode.commands.executeCommand('vscode.diff', originalDoc.uri, modifiedDoc.uri, title);
        }
        catch {
            // ignore
        }
    }
    _pushUndoBatch(batch) {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this._undoBatches.push({ id, at: Date.now(), label: batch.label, ops: batch.ops });
        if (this._undoBatches.length > 20)
            this._undoBatches = this._undoBatches.slice(-20);
        this._sendUndoStatus();
    }
    _sendUndoStatus() {
        const last = this._undoBatches.length ? this._undoBatches[this._undoBatches.length - 1] : null;
        this._sendToWebview({
            type: 'undoStatus',
            status: {
                canUndo: !!last,
                label: last ? last.label : ''
            }
        });
    }
    async _undoLastApply() {
        const batch = this._undoBatches.length ? this._undoBatches[this._undoBatches.length - 1] : null;
        if (!batch) {
            vscode.window.showInformationMessage('Azure Codex: Nothing to undo.');
            return;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }
        // Only pop once we know we can attempt the undo.
        this._undoBatches.pop();
        for (const op of [...batch.ops].reverse()) {
            const targetUri = vscode.Uri.joinPath(folders[0].uri, op.path);
            if (!op.prevExists) {
                try {
                    await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: true });
                }
                catch {
                    // ignore
                }
                continue;
            }
            const dir = op.path.split('/').slice(0, -1).join('/');
            if (dir) {
                try {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, dir));
                }
                catch {
                    // ignore
                }
            }
            try {
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(op.prevContent, 'utf8'));
            }
            catch {
                // ignore
            }
        }
        this._sendUndoStatus();
        vscode.window.showInformationMessage(`Azure Codex: Undid "${batch.label}".`);
    }
}
exports.ChatViewProvider = ChatViewProvider;
//# sourceMappingURL=chatViewProvider.js.map