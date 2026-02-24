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
exports.AgentSession = void 0;
const vscode = __importStar(require("vscode"));
class AgentSession {
    constructor(rootUri) {
        this._staged = new Map();
        this._checkpoints = [];
        this._step = 0;
        this._rootUri = rootUri;
    }
    get step() {
        return this._step;
    }
    listStaged() {
        return Array.from(this._staged.values()).sort((a, b) => a.path.localeCompare(b.path));
    }
    listCheckpoints() {
        return [...this._checkpoints].sort((a, b) => a.step - b.step);
    }
    beginStep(label) {
        this._step++;
        const snap = {};
        for (const [p, c] of this._staged.entries())
            snap[p] = c.nextContent;
        this._checkpoints.push({ step: this._step, at: Date.now(), label, nextByPath: snap });
        if (this._checkpoints.length > 50)
            this._checkpoints.shift();
    }
    revertToStep(step) {
        const cp = [...this._checkpoints].reverse().find((c) => c.step === step);
        if (!cp)
            return;
        // Remove staged not in snapshot
        for (const p of Array.from(this._staged.keys())) {
            if (!(p in cp.nextByPath))
                this._staged.delete(p);
        }
        for (const [p, c] of this._staged.entries()) {
            if (p in cp.nextByPath)
                c.nextContent = cp.nextByPath[p];
        }
        // Trim checkpoints after step
        while (this._checkpoints.length && this._checkpoints[this._checkpoints.length - 1].step > step) {
            this._checkpoints.pop();
        }
        this._step = step;
    }
    discardAll() {
        this._staged.clear();
    }
    async readFile(path, maxChars) {
        const p = this._normalizeRelPath(path);
        if (!p)
            return null;
        const staged = this._staged.get(p);
        if (staged)
            return staged.nextContent.slice(0, maxChars);
        const uri = vscode.Uri.joinPath(this._rootUri, p);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf8');
            return text.slice(0, maxChars);
        }
        catch {
            return null;
        }
    }
    async stageWrite(path, nextContent) {
        const p = this._normalizeRelPath(path);
        if (!p)
            throw new Error('Invalid path.');
        const existing = this._staged.get(p);
        if (existing) {
            existing.nextContent = nextContent;
            return;
        }
        const uri = vscode.Uri.joinPath(this._rootUri, p);
        let prevExists = false;
        let prevContent = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            prevExists = true;
            prevContent = Buffer.from(bytes).toString('utf8');
        }
        catch {
            prevExists = false;
            prevContent = '';
        }
        this._staged.set(p, { path: p, uri, prevExists, prevContent, nextContent });
    }
    _normalizeRelPath(raw) {
        const p = String(raw || '').trim().replace(/^["']|["']$/g, '');
        if (!p)
            return null;
        if (p.startsWith('/') || p.startsWith('~') || p.startsWith('..') || p.includes('\\') || p.includes(':'))
            return null;
        return p;
    }
}
exports.AgentSession = AgentSession;
//# sourceMappingURL=agentSession.js.map