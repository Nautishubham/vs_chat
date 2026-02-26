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
exports.FileContextManager = void 0;
exports.languageFromPath = languageFromPath;
const path = __importStar(require("path"));
class FileContextManager {
    constructor() {
        this._items = new Map(); // id -> item
        this._orderSeq = 0;
    }
    list() {
        return Array.from(this._items.values()).sort((a, b) => a.order - b.order);
    }
    listByTier(tier) {
        return this.list().filter((i) => i.tier === tier);
    }
    get(id) {
        return this._items.get(id);
    }
    getByPath(displayPath) {
        for (const item of this._items.values()) {
            if (item.path === displayPath)
                return item;
        }
        return undefined;
    }
    remove(id) {
        return this._items.delete(id);
    }
    removeByTier(tier) {
        const ids = this.listByTier(tier).map((i) => i.id);
        for (const id of ids)
            this._items.delete(id);
        return ids.length;
    }
    clearConversationScoped() {
        this.removeByTier('conversation');
        this.removeByTier('oneTime');
    }
    clear() {
        this._items.clear();
    }
    setTier(id, tier) {
        const item = this._items.get(id);
        if (!item)
            return false;
        item.tier = tier;
        item.order = ++this._orderSeq;
        return true;
    }
    markUsed(ids, messageNumber) {
        for (const id of ids) {
            const item = this._items.get(id);
            if (!item)
                continue;
            item.lastUsedMessage = Math.max(item.lastUsedMessage || 0, messageNumber);
            item.order = ++this._orderSeq;
            item.staleSuggestedAtMessage = undefined;
        }
    }
    dismissStalePrompt(id) {
        const item = this._items.get(id);
        if (!item)
            return false;
        item.stalePromptDismissed = true;
        return true;
    }
    reorderWithinTier(tier, orderedIds) {
        const current = this.listByTier(tier);
        const index = new Map(orderedIds.map((id, i) => [id, i]));
        const sorted = [...current].sort((a, b) => {
            const ia = index.has(a.id) ? index.get(a.id) : Number.MAX_SAFE_INTEGER;
            const ib = index.has(b.id) ? index.get(b.id) : Number.MAX_SAFE_INTEGER;
            if (ia !== ib)
                return ia - ib;
            return a.order - b.order;
        });
        for (const item of sorted) {
            item.order = ++this._orderSeq;
        }
    }
    removeOneTimeAfterUse(messageNumber) {
        const removed = [];
        for (const item of this._items.values()) {
            if (item.tier !== 'oneTime')
                continue;
            if ((item.lastUsedMessage || 0) < messageNumber)
                continue;
            removed.push(item);
        }
        for (const item of removed)
            this._items.delete(item.id);
        return removed;
    }
    upsertText(args) {
        const id = args.id ?? args.displayPath;
        const name = path.basename(args.displayPath);
        const language = languageFromPath(args.displayPath);
        const prev = this._items.get(id);
        this._items.set(id, {
            id,
            kind: 'text',
            source: args.source,
            tier: args.tier || prev?.tier || 'conversation',
            name,
            path: args.displayPath,
            language,
            sizeBytes: args.sizeBytes,
            tokenCount: Math.max(0, Number(args.tokenCount || prev?.tokenCount || 0)),
            addedAt: Date.now(),
            order: ++this._orderSeq,
            lastUsedMessage: prev?.lastUsedMessage || 0,
            stalePromptDismissed: prev?.stalePromptDismissed,
            staleSuggestedAtMessage: prev?.staleSuggestedAtMessage,
            missingOnDisk: prev?.missingOnDisk,
            changedOnDisk: prev?.changedOnDisk,
            lastKnownMtimeMs: Number(args.lastKnownMtimeMs ?? prev?.lastKnownMtimeMs ?? 0) || undefined,
            isVirtual: !!args.isVirtual,
            text: args.text
        });
    }
    upsertImage(args) {
        const id = args.id ?? args.displayPath;
        const name = path.basename(args.displayPath);
        const language = languageFromPath(args.displayPath);
        const prev = this._items.get(id);
        this._items.set(id, {
            id,
            kind: 'image',
            source: args.source,
            tier: args.tier || prev?.tier || 'conversation',
            name,
            path: args.displayPath,
            language,
            sizeBytes: args.sizeBytes,
            tokenCount: Math.max(0, Number(args.tokenCount || prev?.tokenCount || 0)),
            addedAt: Date.now(),
            order: ++this._orderSeq,
            lastUsedMessage: prev?.lastUsedMessage || 0,
            stalePromptDismissed: prev?.stalePromptDismissed,
            staleSuggestedAtMessage: prev?.staleSuggestedAtMessage,
            missingOnDisk: prev?.missingOnDisk,
            changedOnDisk: prev?.changedOnDisk,
            lastKnownMtimeMs: Number(args.lastKnownMtimeMs ?? prev?.lastKnownMtimeMs ?? 0) || undefined,
            dataUrl: args.dataUrl
        });
    }
}
exports.FileContextManager = FileContextManager;
function languageFromPath(filePath) {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const map = {
        ts: 'typescript',
        tsx: 'tsx',
        js: 'javascript',
        jsx: 'jsx',
        py: 'python',
        go: 'go',
        rs: 'rust',
        java: 'java',
        cs: 'csharp',
        rb: 'ruby',
        php: 'php',
        sh: 'shell',
        ps1: 'powershell',
        json: 'json',
        yml: 'yaml',
        yaml: 'yaml',
        toml: 'toml',
        md: 'markdown',
        html: 'html',
        css: 'css',
        xml: 'xml',
        txt: 'text',
        pdf: 'pdf',
        csv: 'csv',
        xlsx: 'excel',
        xls: 'excel',
        docx: 'docx',
        pptx: 'pptx',
        png: 'image',
        jpg: 'image',
        jpeg: 'image',
        webp: 'image',
        gif: 'image'
    };
    return map[ext] || 'text';
}
//# sourceMappingURL=fileContextManager.js.map