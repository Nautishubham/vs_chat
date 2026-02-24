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
exports.DiagnosticsQuickFixProvider = void 0;
exports.fixDiagnosticsForActiveFile = fixDiagnosticsForActiveFile;
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
async function showDiffPreview(before, after, title) {
    try {
        const originalDoc = await vscode.workspace.openTextDocument({ content: before });
        const modifiedDoc = await vscode.workspace.openTextDocument({ content: after });
        await vscode.commands.executeCommand('vscode.diff', originalDoc.uri, modifiedDoc.uri, title);
    }
    catch {
        // ignore
    }
}
function fullDocumentRange(doc) {
    const lastLine = Math.max(0, doc.lineCount - 1);
    const lastChar = doc.lineAt(lastLine).text.length;
    return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastChar));
}
function buildDiagnosticsContext(doc, diags) {
    const windows = [];
    for (const d of diags) {
        const line = d.range.start.line;
        windows.push({ start: Math.max(0, line - 6), end: Math.min(doc.lineCount - 1, line + 6) });
    }
    windows.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const w of windows) {
        const last = merged[merged.length - 1];
        if (!last || w.start > last.end + 2)
            merged.push({ ...w });
        else
            last.end = Math.max(last.end, w.end);
    }
    const parts = [];
    for (const m of merged.slice(0, 12)) {
        const snippet = doc.getText(new vscode.Range(new vscode.Position(m.start, 0), new vscode.Position(m.end + 1, 0)));
        parts.push(`Lines ${m.start + 1}-${m.end + 1}:\n${snippet}`);
    }
    return parts.join('\n\n---\n\n');
}
async function fixDiagnosticsForActiveFile(client) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const doc = editor.document;
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);
    const language = doc.languageId;
    const diags = vscode.languages.getDiagnostics(doc.uri) || [];
    if (!diags.length) {
        vscode.window.showInformationMessage('Azure Codex: No diagnostics found for the active file.');
        return;
    }
    const diagList = diags
        .slice(0, 50)
        .map((d) => {
        const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
        const code = d.code ? ` (${String(d.code)})` : '';
        return `- ${pos}${code}: ${d.message}`;
    })
        .join('\n');
    const context = buildDiagnosticsContext(doc, diags);
    const prompt = `Fix the diagnostics in this file.\n\n` +
        `File: ${relPath}\nLanguage: ${language}\n\n` +
        `Diagnostics:\n${diagList}\n\n` +
        `Relevant code context:\n\`\`\`${language}\n${context}\n\`\`\`\n\n` +
        `Return ONLY a single \`\`\`edit\`\`\` block for ${relPath} that fixes these issues.\n` +
        `- Each SEARCH must match exactly once in the current file.\n` +
        `- Keep changes minimal.\n`;
    const response = await client.chatToText([], prompt);
    const editBlock = extractFencedBlocks(response).find((b) => b.lang === 'edit');
    if (!editBlock) {
        vscode.window.showErrorMessage('Azure Codex: No ```edit``` block found in the response.');
        return;
    }
    const parsed = parsePathBlock(editBlock.code);
    if (!parsed) {
        vscode.window.showErrorMessage('Azure Codex: Could not parse edit block (expected first line like "path: ...").');
        return;
    }
    const current = doc.getText();
    const applied = applySearchReplaceEdits(current, parsed.content);
    if (!applied.ok) {
        vscode.window.showErrorMessage(`Azure Codex: Failed to apply edit block: ${applied.error}`);
        return;
    }
    await showDiffPreview(current, applied.updated, `Azure Codex: Fix diagnostics preview — ${relPath}`);
    const confirm = await vscode.window.showWarningMessage(`Apply fixes to ${relPath}?`, { modal: true }, 'Apply');
    if (confirm !== 'Apply')
        return;
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, fullDocumentRange(doc), applied.updated);
    await vscode.workspace.applyEdit(we);
    await doc.save();
    vscode.window.showInformationMessage(`Azure Codex: Applied ${applied.count} fix(es) to ${relPath}.`);
}
class DiagnosticsQuickFixProvider {
    provideCodeActions(document, _range, context) {
        if (!context.diagnostics.length)
            return [];
        const action = new vscode.CodeAction('Fix with Azure Codex', vscode.CodeActionKind.QuickFix);
        action.command = { command: 'azureCodex.fixDiagnostics', title: 'Fix with Azure Codex', arguments: [document.uri] };
        action.diagnostics = [...context.diagnostics];
        action.isPreferred = true;
        return [action];
    }
}
exports.DiagnosticsQuickFixProvider = DiagnosticsQuickFixProvider;
DiagnosticsQuickFixProvider.providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
//# sourceMappingURL=diagnosticsFix.js.map