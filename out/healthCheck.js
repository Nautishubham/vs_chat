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
exports.runHealthCheck = runHealthCheck;
const vscode = __importStar(require("vscode"));
async function runHealthCheck(client) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Azure Codex: Running health check…' }, async (progress) => {
        // Reload on-demand so changes to workspace .env are picked up immediately.
        client.reloadConfig();
        const targets = client.getResolvedTargets();
        const results = [];
        progress.report({ message: 'Checking configuration…' });
        if (!client.isConfigured()) {
            vscode.window.showErrorMessage(client.getConfigError());
            return;
        }
        progress.report({ message: 'Pinging chat model…' });
        try {
            await client.pingChat();
            results.push(`Chat: OK (${targets.chat.deployment})`);
        }
        catch (e) {
            results.push(`Chat: FAILED (${targets.chat.deployment}) (${e?.message || String(e)})`);
        }
        progress.report({ message: 'Pinging embeddings…' });
        try {
            const dims = await client.pingEmbeddings();
            results.push(`Embeddings: OK (${targets.embeddings.deployment}, dim=${dims})`);
        }
        catch (e) {
            results.push(`Embeddings: FAILED (${targets.embeddings.deployment}) (${e?.message || String(e)})`);
        }
        const allOk = results.every((r) => r.includes(': OK'));
        if (allOk) {
            vscode.window.showInformationMessage(`Azure Codex health check passed: ${results.join(' · ')}`);
        }
        else {
            vscode.window.showWarningMessage(`Azure Codex health check: ${results.join(' · ')}\n` +
                `Chat endpoint: ${targets.chat.endpoint}\n` +
                `Embeddings endpoint: ${targets.embeddings.endpoint}`);
        }
    });
}
//# sourceMappingURL=healthCheck.js.map