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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InlineEditPreviewManager = void 0;
const vscode = __importStar(require("vscode"));
function extractFencedBlocks(text) {
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
function parsePathBlock(code) {
    const lines = String(code || '').replace(/\r\n/g, '\n').split('\n');
    const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
    if (firstNonEmptyIdx === -1)
        return null;
    const first = lines[firstNonEmptyIdx].trim();
    const match = first.match(/^path:\s*(.+)\s*$/i);
    if (!match)
        return null;
    const rawPath = match[1].trim().replace(/^["']|["']$/g, '');
    if (!rawPath)
        return null;
    const content = lines.slice(firstNonEmptyIdx + 1).join('\n');
    return { path: rawPath, content };
}
function applySearchReplaceEdits(original, editBlockContent) {
    const lines = String(editBlockContent || '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        if (lines[i].trim() !== '<<<<<<< SEARCH') {
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
        const idx = updated.indexOf(b.search);
        if (idx === -1)
            return { ok: false, error: 'SEARCH block not found in file.' };
        if (updated.indexOf(b.search, idx + 1) !== -1)
            return { ok: false, error: 'SEARCH block is not unique in file.' };
        updated = updated.slice(0, idx) + b.replace + updated.slice(idx + b.search.length);
        count++;
    }
    return { ok: true, updated, count };
}
function fullDocumentRange(doc) {
    const lastLine = Math.max(0, doc.lineCount - 1);
    const lastChar = doc.lineAt(lastLine).text.length;
    return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastChar));
}
class InlineEditPreviewManager {
    constructor() {
        this._active = null;
    }
    async _setCtx(active) {
        try {
            await vscode.commands.executeCommand('setContext', 'azureCodexInlineEditPreviewActive', active);
        }
        catch {
            // ignore
        }
    }
    isActive() {
        return !!this._active;
    }
    async accept() {
        if (!this._active)
            return;
        const doc = await vscode.workspace.openTextDocument(this._active.uri);
        await doc.save();
        this._active = null;
        await this._setCtx(false);
        vscode.window.showInformationMessage('Azure Codex: Inline edit applied.');
    }
    async reject() {
        if (!this._active)
            return;
        const doc = await vscode.workspace.openTextDocument(this._active.uri);
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, fullDocumentRange(doc), this._active.original);
        await vscode.workspace.applyEdit(we);
        this._active = null;
        await this._setCtx(false);
        vscode.window.showInformationMessage('Azure Codex: Inline edit rejected.');
    }
    async runCmdK(client) {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        if (this._active) {
            const picked = await vscode.window.showQuickPick([
                { label: 'Accept', action: 'accept' },
                { label: 'Reject', action: 'reject' }
            ], { placeHolder: 'Inline edit preview is active' });
            if (!picked)
                return;
            if (picked.action === 'accept')
                return await this.accept();
            if (picked.action === 'reject')
                return await this.reject();
            return;
        }
        const doc = editor.document;
        const relPath = vscode.workspace.asRelativePath(doc.uri, false);
        const language = doc.languageId;
        const instruction = await vscode.window.showInputBox({
            prompt: 'Edit instruction (Cmd+K)',
            placeHolder: 'e.g. convert to async/await, add error handling, refactor into function'
        });
        if (!instruction)
            return;
        let targetText = '';
        if (!editor.selection.isEmpty) {
            targetText = doc.getText(editor.selection);
        }
        else {
            const line = editor.selection.active.line;
            const start = Math.max(0, line - 10);
            const end = Math.min(doc.lineCount, line + 11);
            targetText = doc.getText(new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0)));
        }
        const userPrompt = `You will edit code using a diff-based edit block.\n\n` +
            `Task: ${instruction}\n\n` +
            `Target file: ${relPath}\n` +
            `Language: ${language}\n\n` +
            `Return ONLY a single \`\`\`edit\`\`\` block for that file.\n` +
            `- Each SEARCH must match exactly once in the current file.\n` +
            `- Keep changes minimal.\n\n` +
            `Current snippet (may be partial context):\n` +
            `\`\`\`${language}\n${targetText}\n\`\`\``;
        const abort = new AbortController();
        let response = '';
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Azure Codex: Generating inline edit…', cancellable: true }, async (_p, token) => {
            token.onCancellationRequested(() => abort.abort());
            await client.chat([], userPrompt, {
                onToken: (t) => (response += t),
                onDone: () => { },
                onError: (e) => {
                    throw new Error(String(e || 'Unknown error'));
                }
            }, { signal: abort.signal });
        });
        const editBlock = extractFencedBlocks(response).find((b) => b.lang === 'edit');
        if (!editBlock) {
            vscode.window.showErrorMessage('Azure Codex: No ```edit``` block found.');
            return;
        }
        const parsed = parsePathBlock(editBlock.code);
        if (!parsed) {
            vscode.window.showErrorMessage('Azure Codex: Could not parse edit block (expected "path: ...").');
            return;
        }
        if (parsed.path !== relPath) {
            vscode.window.showWarningMessage(`Azure Codex: Edit block path "${parsed.path}" does not match active file "${relPath}". Applying to active file.`);
        }
        const original = doc.getText();
        const applied = applySearchReplaceEdits(original, parsed.content);
        if (!applied.ok) {
            vscode.window.showErrorMessage(`Azure Codex: Failed to apply edit: ${applied.error}`);
            return;
        }
        // Preview by applying to the in-memory buffer (no save) and letting user accept/reject.
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, fullDocumentRange(doc), applied.updated);
        await vscode.workspace.applyEdit(we);
        this._active = { uri: doc.uri, original, updated: applied.updated };
        await this._setCtx(true);
        const picked = await vscode.window.showInformationMessage(`Azure Codex: Previewing ${applied.count} edit(s).`, 'Accept', 'Reject');
        if (picked === 'Accept')
            return await this.accept();
        if (picked === 'Reject')
            return await this.reject();
    }
}
exports.InlineEditPreviewManager = InlineEditPreviewManager;
//# sourceMappingURL=inlineEditCmdK.js.map