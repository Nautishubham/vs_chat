import * as vscode from 'vscode';
import { AzureOpenAIClient } from './azureClient';

function extractFencedBlocks(text: string): Array<{ lang: string; code: string }> {
  const out: Array<{ lang: string; code: string }> = [];
  const s = String(text || '');
  const fence = '```';
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf(fence, i);
    if (start === -1) break;
    const langEnd = s.indexOf('\n', start + fence.length);
    if (langEnd === -1) break;
    const lang = s.slice(start + fence.length, langEnd).trim().toLowerCase();
    const end = s.indexOf(fence, langEnd + 1);
    if (end === -1) break;
    const code = s.slice(langEnd + 1, end).replace(/\r\n/g, '\n').trim();
    out.push({ lang, code });
    i = end + fence.length;
  }
  return out;
}

function parsePathBlock(code: string): { path: string; content: string } | null {
  const lines = String(code || '').replace(/\r\n/g, '\n').split('\n');
  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx === -1) return null;
  const first = lines[firstNonEmptyIdx].trim();
  const match = first.match(/^path:\s*(.+)\s*$/i);
  if (!match) return null;
  const rawPath = match[1].trim().replace(/^["']|["']$/g, '');
  if (!rawPath) return null;
  const content = lines.slice(firstNonEmptyIdx + 1).join('\n');
  return { path: rawPath, content };
}

function applySearchReplaceEdits(
  original: string,
  editBlockContent: string
): { ok: true; updated: string; count: number } | { ok: false; error: string } {
  const lines = String(editBlockContent || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: Array<{ search: string; replace: string }> = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    i++;
    const searchLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '=======') {
      searchLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length || lines[i].trim() !== '=======') return { ok: false, error: 'Malformed edit block (missing =======).' };
    i++;
    const replaceLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '>>>>>>> REPLACE') {
      replaceLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length || lines[i].trim() !== '>>>>>>> REPLACE')
      return { ok: false, error: 'Malformed edit block (missing >>>>>>> REPLACE).' };
    i++;
    blocks.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
  }

  if (!blocks.length) return { ok: false, error: 'No SEARCH/REPLACE blocks found.' };

  let updated = String(original || '').replace(/\r\n/g, '\n');
  let count = 0;
  for (const b of blocks) {
    const idx = updated.indexOf(b.search);
    if (idx === -1) return { ok: false, error: 'SEARCH block not found in file.' };
    if (updated.indexOf(b.search, idx + 1) !== -1) return { ok: false, error: 'SEARCH block is not unique in file.' };
    updated = updated.slice(0, idx) + b.replace + updated.slice(idx + b.search.length);
    count++;
  }
  return { ok: true, updated, count };
}

async function showDiffPreview(before: string, after: string, title: string) {
  try {
    const originalDoc = await vscode.workspace.openTextDocument({ content: before });
    const modifiedDoc = await vscode.workspace.openTextDocument({ content: after });
    await vscode.commands.executeCommand('vscode.diff', originalDoc.uri, modifiedDoc.uri, title);
  } catch {
    // ignore
  }
}

function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
  const lastLine = Math.max(0, doc.lineCount - 1);
  const lastChar = doc.lineAt(lastLine).text.length;
  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastChar));
}

export async function runInlineEdit(client: AzureOpenAIClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const relPath = vscode.workspace.asRelativePath(doc.uri, false);
  const language = doc.languageId;

  const instruction = await vscode.window.showInputBox({
    prompt: 'Inline edit instruction',
    placeHolder: 'e.g. convert this to async/await, extract a function, add error handling'
  });
  if (!instruction) return;

  const currentContent = doc.getText();

  let contextText = '';
  let isFullFile = false;
  if (!editor.selection.isEmpty) {
    contextText = doc.getText(editor.selection);
  } else {
    const line = editor.selection.active.line;
    const start = Math.max(0, line - 10);
    const end = Math.min(doc.lineCount, line + 11);
    contextText = doc.getText(new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0)));
  }

  // If the full file is not too large, send it for better context
  if (currentContent.length < 30000) {
    contextText = currentContent;
    isFullFile = true;
  }

  const userPrompt =
    `You will edit code in-place using a diff-based edit block.\n\n` +
    `Task: ${instruction}\n\n` +
    `Target file: ${relPath}\n` +
    `Language: ${language}\n\n` +
    `Return ONLY a single \`\`\`edit\`\`\` block for that file.\n` +
    `- Each SEARCH must match exactly once in the current file.\n` +
    `- Keep changes minimal and localized.\n\n` +
    `${isFullFile ? 'Current file content' : 'Current snippet to change (may be partial context)'}:\n` +
    `\`\`\`${language}\n${contextText}\n\`\`\``;

  const response = await client.chatToText([], userPrompt);
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

  // Use the content we had when prompting
  const applied = applySearchReplaceEdits(currentContent, parsed.content);
  if (!applied.ok) {
    vscode.window.showErrorMessage(`Azure Codex: Failed to apply edit block: ${applied.error}`);
    return;
  }

  await showDiffPreview(currentContent, applied.updated, `Azure Codex: Inline edit preview — ${relPath}`);
  const confirm = await vscode.window.showWarningMessage(`Apply inline edit to ${relPath}?`, { modal: true }, 'Apply');
  if (confirm !== 'Apply') return;

  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, fullDocumentRange(doc), applied.updated);
  await vscode.workspace.applyEdit(we);
  await doc.save();
}

