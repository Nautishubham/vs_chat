import * as vscode from 'vscode';
import { AzureOpenAIClient } from './azureClient';
import { ModelRouter } from './modelRouter';

type CacheEntry = { at: number; text: string };

export class AzureCodexInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly _client: AzureOpenAIClient;
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _router = new ModelRouter();

  constructor(client: AzureOpenAIClient) {
    this._client = client;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null> {
    const config = vscode.workspace.getConfiguration('azureCodex');
    const enabled = config.get<boolean>('autocompleteEnabled', false);
    if (!enabled) return null;
    if (!this._client.isConfigured()) return null;
    if (document.isUntitled) return null;

    const key = `${document.uri.toString()}@${document.version}:${position.line}:${position.character}`;
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.at < 30_000) {
      return cached.text ? [new vscode.InlineCompletionItem(cached.text)] : null;
    }

    const startLine = Math.max(0, position.line - 200);
    const prefixRange = new vscode.Range(new vscode.Position(startLine, 0), position);
    const prefix = document.getText(prefixRange);

    const endLine = Math.min(document.lineCount - 1, position.line + 80);
    const suffixRange = new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length));
    const suffix = document.getText(suffixRange);

    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    let out = '';
    try {
      const model = this._router.getAutocompleteDeployment(vscode.workspace.getConfiguration('azureCodex').get<string>('deploymentName', ''));
      await this._client.completeInline(
        { language: document.languageId, prefix, suffix },
        {
          onToken: (t) => (out += t),
          onDone: () => {},
          onError: () => {}
        },
        { signal: abort.signal, model }
      );
    } catch {
      out = '';
    }

    out = String(out || '').replace(/\r\n/g, '\n');
    // Avoid returning whitespace-only suggestions.
    if (!out.trim()) out = '';

    this._cache.set(key, { at: Date.now(), text: out });
    if (!out) return null;
    return [new vscode.InlineCompletionItem(out)];
  }
}
