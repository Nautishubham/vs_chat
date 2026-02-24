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
exports.configureEmbeddingsSettings = configureEmbeddingsSettings;
const vscode = __importStar(require("vscode"));
const healthCheck_1 = require("./healthCheck");
function normalizeEndpoint(value) {
    const v = String(value || '').trim();
    if (!v)
        return '';
    return v.replace(/\/+$/, '');
}
async function configureEmbeddingsSettings(client) {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const endpoint = normalizeEndpoint((await vscode.window.showInputBox({
        prompt: 'Embeddings endpoint (base resource URL)',
        placeHolder: 'https://<resource>.openai.azure.com',
        value: normalizeEndpoint(cfg.get('embeddingsEndpoint', ''))
    })) ?? '');
    if (!endpoint)
        return;
    const deploymentName = (await vscode.window.showInputBox({
        prompt: 'Embeddings deployment name',
        placeHolder: 'text-embedding-3-large',
        value: cfg.get('embeddingsDeploymentName', '') || 'text-embedding-3-large'
    })) || '';
    if (!deploymentName.trim())
        return;
    const apiVersion = (await vscode.window.showInputBox({
        prompt: 'Embeddings api-version (legacy deployments embeddings endpoint)',
        placeHolder: '2023-05-15',
        value: cfg.get('embeddingsApiVersion', '') || '2023-05-15'
    })) || '';
    if (!apiVersion.trim())
        return;
    const apiKey = (await vscode.window.showInputBox({
        prompt: 'Embeddings API key (stored in VS Code settings)',
        password: true,
        value: cfg.get('embeddingsApiKey', '')
    })) || '';
    if (!apiKey.trim())
        return;
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update('embeddingsEndpoint', endpoint, target);
    await cfg.update('embeddingsDeploymentName', deploymentName.trim(), target);
    await cfg.update('embeddingsApiVersion', apiVersion.trim(), target);
    await cfg.update('embeddingsApiKey', apiKey.trim(), target);
    client.reloadConfig();
    const picked = await vscode.window.showInformationMessage('Azure Codex: Saved embeddings settings to your user settings.', 'Run Health Check');
    if (picked === 'Run Health Check') {
        await (0, healthCheck_1.runHealthCheck)(client);
    }
}
//# sourceMappingURL=configureEmbeddings.js.map