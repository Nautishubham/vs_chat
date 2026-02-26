import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { AzureOpenAIClient } from './azureClient';
import { SemanticIndex } from './semanticIndex';
import { runInlineEdit } from './inlineEdit';
import { AzureCodexInlineCompletionProvider } from './autocompleteProvider';
import { DiagnosticsQuickFixProvider, fixDiagnosticsForActiveFile } from './diagnosticsFix';
import { runHealthCheck } from './healthCheck';
import { configureEmbeddingsSettings } from './configureEmbeddings';
import { MemoryStore } from './memoryStore';
import { ModelRouter } from './modelRouter';
import { InlineEditPreviewManager } from './inlineEditCmdK';

export function activate(context: vscode.ExtensionContext) {
  console.log('Azure Codex Chat extension activated');

  const azureClient = new AzureOpenAIClient();
  const semanticIndex = new SemanticIndex({ client: azureClient, storageUri: context.globalStorageUri });
  const memoryStore = new MemoryStore(context);
  const modelRouter = new ModelRouter();
  const chatProvider = new ChatViewProvider(context.extensionUri, azureClient, { semanticIndex, memoryStore, modelRouter });
  const inlineEditPreview = new InlineEditPreviewManager();

  // Register the sidebar webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('azureCodex.chatView', chatProvider)
  );

  // Inline autocomplete (optional)
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: 'file' },
      new AzureCodexInlineCompletionProvider(azureClient)
    )
  );

  // Command: Open Chat Panel
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.openChat', async () => {
      await vscode.commands.executeCommand('azureCodex.chatView.focus');
      await chatProvider.startFreshChatOnOpen();
    })
  );

  // Command: Explain Code
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.explainCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      if (!selectedText) {
        vscode.window.showWarningMessage('Please select code to explain.');
        return;
      }

      const language = editor.document.languageId;
      const prompt = `Explain the following ${language} code clearly and concisely:\n\n\`\`\`${language}\n${selectedText}\n\`\`\``;

      await chatProvider.sendMessageFromCommand(prompt, `Explain Code (${language})`);
      vscode.commands.executeCommand('azureCodex.chatView.focus');
    })
  );

  // Command: Fix Code
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.fixCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      if (!selectedText) {
        vscode.window.showWarningMessage('Please select code to fix.');
        return;
      }

      const language = editor.document.languageId;
      const prompt = `Find and fix any bugs, errors, or issues in this ${language} code. Explain what was wrong and provide the corrected version:\n\n\`\`\`${language}\n${selectedText}\n\`\`\``;

      await chatProvider.sendMessageFromCommand(prompt, `Fix Code (${language})`);
      vscode.commands.executeCommand('azureCodex.chatView.focus');
    })
  );

  // Command: Generate Code
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.generateCode', async () => {
      const editor = vscode.window.activeTextEditor;
      const language = editor?.document.languageId || 'python';

      const input = await vscode.window.showInputBox({
        prompt: 'Describe what code you want to generate',
        placeHolder: 'e.g. A function that sorts a list of dictionaries by a given key'
      });

      if (!input) return;

      const prompt = `Generate ${language} code for the following task:\n\n${input}\n\nProvide clean, well-commented, production-ready code.`;
      await chatProvider.sendMessageFromCommand(prompt, 'Generate Code');
      vscode.commands.executeCommand('azureCodex.chatView.focus');
    })
  );

  // Command: Clear Chat
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.clearChat', () => {
      chatProvider.clearHistory();
    })
  );

  // Command: Undo Last Apply
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.undoLastApply', async () => {
      await chatProvider.undoLastApply();
    })
  );

  // Command: Open Session History
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.openSessionHistory', async () => {
      await chatProvider.openSessionHistory();
    })
  );

  // Command: (Re)build Semantic Index
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.buildSemanticIndex', async () => {
      await semanticIndex.ensureBuilt({ force: true, progressTitle: 'Azure Codex: Building semantic index…' });
      vscode.window.showInformationMessage('Azure Codex: Semantic index built.');
    })
  );

  // Command: Inline Edit (Cursor-style)
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.inlineEdit', async () => {
      await runInlineEdit(azureClient);
    })
  );

  // Command: Inline Edit (Cmd+K) with preview accept/reject
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.inlineEditCmdK', async () => {
      await inlineEditPreview.runCmdK(azureClient);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.inlineEditAccept', async () => {
      await inlineEditPreview.accept();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.inlineEditReject', async () => {
      await inlineEditPreview.reject();
    })
  );

  // Command: Fix diagnostics for active file
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.fixDiagnostics', async (uri?: vscode.Uri) => {
      if (uri) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch {
          // ignore
        }
      }
      await fixDiagnosticsForActiveFile(azureClient);
    })
  );

  // Command: Health check (chat + embeddings)
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.healthCheck', async () => {
      await runHealthCheck(azureClient);
    })
  );

  // Command: Configure embeddings settings (avoids .env confusion)
  context.subscriptions.push(
    vscode.commands.registerCommand('azureCodex.configureEmbeddings', async () => {
      await configureEmbeddingsSettings(azureClient);
    })
  );

  // Quick-fix integration for diagnostics
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new DiagnosticsQuickFixProvider(),
      { providedCodeActionKinds: DiagnosticsQuickFixProvider.providedCodeActionKinds }
    )
  );

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('azureCodex')) {
        azureClient.reloadConfig();
      }
    })
  );
}

export function deactivate() {}
