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
exports.AzureCodexInlineCompletionProvider = void 0;
const vscode = __importStar(require("vscode"));
const modelRouter_1 = require("./modelRouter");
class AzureCodexInlineCompletionProvider {
    constructor(client) {
        this._cache = new Map();
        this._router = new modelRouter_1.ModelRouter();
        this._client = client;
    }
    async provideInlineCompletionItems(document, position, _context, token) {
        const config = vscode.workspace.getConfiguration('azureCodex');
        const enabled = config.get('autocompleteEnabled', false);
        if (!enabled)
            return null;
        if (!this._client.isConfigured())
            return null;
        if (document.isUntitled)
            return null;
        const key = `${document.uri.toString()}@${document.version}:${position.line}:${position.character}`;
        const cached = this._cache.get(key);
        if (cached && Date.now() - cached.at < 30000) {
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
            const model = this._router.getAutocompleteDeployment(vscode.workspace.getConfiguration('azureCodex').get('deploymentName', ''));
            await this._client.completeInline({ language: document.languageId, prefix, suffix }, {
                onToken: (t) => (out += t),
                onDone: () => { },
                onError: () => { }
            }, { signal: abort.signal, model });
        }
        catch {
            out = '';
        }
        out = String(out || '').replace(/\r\n/g, '\n');
        // Avoid returning whitespace-only suggestions.
        if (!out.trim())
            out = '';
        this._cache.set(key, { at: Date.now(), text: out });
        if (!out)
            return null;
        return [new vscode.InlineCompletionItem(out)];
    }
}
exports.AzureCodexInlineCompletionProvider = AzureCodexInlineCompletionProvider;
//# sourceMappingURL=autocompleteProvider.js.map