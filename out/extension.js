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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const chatViewProvider_1 = require("./chatViewProvider");
const azureClient_1 = require("./azureClient");
const semanticIndex_1 = require("./semanticIndex");
const inlineEdit_1 = require("./inlineEdit");
const autocompleteProvider_1 = require("./autocompleteProvider");
const diagnosticsFix_1 = require("./diagnosticsFix");
const healthCheck_1 = require("./healthCheck");
const configureEmbeddings_1 = require("./configureEmbeddings");
const memoryStore_1 = require("./memoryStore");
const modelRouter_1 = require("./modelRouter");
const inlineEditCmdK_1 = require("./inlineEditCmdK");
function activate(context) {
    console.log('Azure Codex Chat extension activated');
    const azureClient = new azureClient_1.AzureOpenAIClient();
    const semanticIndex = new semanticIndex_1.SemanticIndex({ client: azureClient, storageUri: context.globalStorageUri });
    const memoryStore = new memoryStore_1.MemoryStore(context);
    const modelRouter = new modelRouter_1.ModelRouter();
    const chatProvider = new chatViewProvider_1.ChatViewProvider(context.extensionUri, azureClient, { semanticIndex, memoryStore, modelRouter });
    const inlineEditPreview = new inlineEditCmdK_1.InlineEditPreviewManager();
    // Register the sidebar webview
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('azureCodex.chatView', chatProvider));
    // Inline autocomplete (optional)
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, new autocompleteProvider_1.AzureCodexInlineCompletionProvider(azureClient)));
    // Command: Open Chat Panel
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.openChat', async () => {
        await vscode.commands.executeCommand('azureCodex.chatView.focus');
        await chatProvider.startFreshChatOnOpen();
    }));
    // Command: Explain Code
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.explainCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
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
    }));
    // Command: Fix Code
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.fixCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
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
    }));
    // Command: Generate Code
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.generateCode', async () => {
        const editor = vscode.window.activeTextEditor;
        const language = editor?.document.languageId || 'python';
        const input = await vscode.window.showInputBox({
            prompt: 'Describe what code you want to generate',
            placeHolder: 'e.g. A function that sorts a list of dictionaries by a given key'
        });
        if (!input)
            return;
        const prompt = `Generate ${language} code for the following task:\n\n${input}\n\nProvide clean, well-commented, production-ready code.`;
        await chatProvider.sendMessageFromCommand(prompt, 'Generate Code');
        vscode.commands.executeCommand('azureCodex.chatView.focus');
    }));
    // Command: Clear Chat
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.clearChat', () => {
        chatProvider.clearHistory();
    }));
    // Command: Undo Last Apply
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.undoLastApply', async () => {
        await chatProvider.undoLastApply();
    }));
    // Command: Open Session History
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.openSessionHistory', async () => {
        await chatProvider.openSessionHistory();
    }));
    // Command: (Re)build Semantic Index
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.buildSemanticIndex', async () => {
        await semanticIndex.ensureBuilt({ force: true, progressTitle: 'Azure Codex: Building semantic index…' });
        vscode.window.showInformationMessage('Azure Codex: Semantic index built.');
    }));
    // Command: Inline Edit (Cursor-style)
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.inlineEdit', async () => {
        await (0, inlineEdit_1.runInlineEdit)(azureClient);
    }));
    // Command: Inline Edit (Cmd+K) with preview accept/reject
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.inlineEditCmdK', async () => {
        await inlineEditPreview.runCmdK(azureClient);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.inlineEditAccept', async () => {
        await inlineEditPreview.accept();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.inlineEditReject', async () => {
        await inlineEditPreview.reject();
    }));
    // Command: Fix diagnostics for active file
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.fixDiagnostics', async (uri) => {
        if (uri) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: false });
            }
            catch {
                // ignore
            }
        }
        await (0, diagnosticsFix_1.fixDiagnosticsForActiveFile)(azureClient);
    }));
    // Command: Health check (chat + embeddings)
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.healthCheck', async () => {
        await (0, healthCheck_1.runHealthCheck)(azureClient);
    }));
    // Command: Configure embeddings settings (avoids .env confusion)
    context.subscriptions.push(vscode.commands.registerCommand('azureCodex.configureEmbeddings', async () => {
        await (0, configureEmbeddings_1.configureEmbeddingsSettings)(azureClient);
    }));
    // Quick-fix integration for diagnostics
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new diagnosticsFix_1.DiagnosticsQuickFixProvider(), { providedCodeActionKinds: diagnosticsFix_1.DiagnosticsQuickFixProvider.providedCodeActionKinds }));
    // Watch for config changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('azureCodex')) {
            azureClient.reloadConfig();
        }
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map