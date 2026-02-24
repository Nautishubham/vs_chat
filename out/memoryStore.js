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
exports.MemoryStore = void 0;
const vscode = __importStar(require("vscode"));
class MemoryStore {
    constructor(context) {
        this._context = context;
    }
    _storageKey(workspaceId) {
        return `azureCodex.memory.${workspaceId}`;
    }
    _workspaceId() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length)
            return 'no-workspace';
        return folders.map((f) => f.uri.fsPath).join('|');
    }
    _getItems() {
        const id = this._workspaceId();
        const raw = this._context.globalState.get(this._storageKey(id), []);
        return Array.isArray(raw) ? raw.filter((x) => x && typeof x.key === 'string' && typeof x.value === 'string') : [];
    }
    async _setItems(items) {
        const id = this._workspaceId();
        await this._context.globalState.update(this._storageKey(id), items);
    }
    list() {
        return this._getItems().sort((a, b) => b.at - a.at);
    }
    async remember(key, value) {
        const k = String(key || '').trim();
        const v = String(value || '').trim();
        if (!k || !v)
            return;
        const items = this._getItems();
        const now = Date.now();
        const filtered = items.filter((i) => i.key !== k);
        filtered.unshift({ key: k, value: v, at: now });
        const config = vscode.workspace.getConfiguration('azureCodex');
        const maxItems = Math.max(5, config.get('memoryMaxItems', 50));
        await this._setItems(filtered.slice(0, maxItems));
    }
    async forget(key) {
        const k = String(key || '').trim();
        if (!k)
            return;
        const items = this._getItems().filter((i) => i.key !== k);
        await this._setItems(items);
    }
    async clear() {
        await this._setItems([]);
    }
    buildContext(maxChars) {
        const config = vscode.workspace.getConfiguration('azureCodex');
        const enabled = config.get('memoryEnabled', true);
        if (!enabled)
            return '';
        const items = this.list();
        if (!items.length)
            return '';
        const lines = ['Project memory (persistent preferences):'];
        for (const i of items) {
            lines.push(`- ${i.key}: ${i.value}`);
        }
        const text = lines.join('\n');
        if (text.length <= maxChars)
            return text;
        return text.slice(0, maxChars) + '\n[truncated]';
    }
}
exports.MemoryStore = MemoryStore;
//# sourceMappingURL=memoryStore.js.map