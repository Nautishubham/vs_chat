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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandHome = expandHome;
exports.looksSensitivePath = looksSensitivePath;
exports.isAbsoluteUserPath = isAbsoluteUserPath;
exports.loadFromAbsolutePath = loadFromAbsolutePath;
exports.loadFromBytes = loadFromBytes;
exports.attachmentToText = attachmentToText;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs_1 = require("fs");
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const XLSX = __importStar(require("xlsx"));
const mammoth = __importStar(require("mammoth"));
const jszip_1 = __importDefault(require("jszip"));
function expandHome(p) {
    const s = String(p || '').trim();
    if (s.startsWith('~/'))
        return path.join(os.homedir(), s.slice(2));
    return s;
}
function looksSensitivePath(p) {
    const s = String(p || '').toLowerCase();
    return (s.endsWith('.env') ||
        s.includes('/.env') ||
        s.includes('\\.env') ||
        s.includes('id_rsa') ||
        s.endsWith('.pem') ||
        s.endsWith('.key') ||
        s.endsWith('.pfx') ||
        s.endsWith('.p12') ||
        s.includes('/node_modules/') ||
        s.includes('\\node_modules\\') ||
        s.includes('node_modules' + path.sep) ||
        s.includes('/.git/') ||
        s.includes('\\.git\\') ||
        s.includes(path.sep + '.git' + path.sep));
}
function isAbsoluteUserPath(p) {
    const s = String(p || '').trim();
    if (!s)
        return false;
    if (s.startsWith('/'))
        return true; // unix/mac
    if (/^[A-Za-z]:\\/.test(s))
        return true; // windows
    if (s.startsWith('~/'))
        return true; // home expansion
    return false;
}
async function loadFromAbsolutePath(absPath, opts) {
    const expanded = expandHome(absPath);
    if (!isAbsoluteUserPath(absPath)) {
        throw new Error('Path must be absolute (or start with ~/).');
    }
    const st = await fs_1.promises.stat(expanded);
    if (!st.isFile())
        throw new Error('Path is not a file.');
    if (st.size > opts.maxBytes)
        throw new Error(`File too large (${st.size} bytes).`);
    const bytes = await fs_1.promises.readFile(expanded);
    return loadFromBytes(path.basename(expanded), expanded, bytes, { maxBytes: opts.maxBytes });
}
async function loadFromBytes(fileName, displayPath, bytes, opts) {
    const safeDisplay = String(displayPath || fileName || 'attachment');
    if (looksSensitivePath(safeDisplay))
        throw new Error('Blocked by sensitive-path policy.');
    if (bytes.byteLength > opts.maxBytes)
        throw new Error(`File too large (${bytes.byteLength} bytes).`);
    const ext = (safeDisplay.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
        const mime = ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : ext === 'png'
                ? 'image/png'
                : ext === 'webp'
                    ? 'image/webp'
                    : ext === 'gif'
                        ? 'image/gif'
                        : 'application/octet-stream';
        const base64 = Buffer.from(bytes).toString('base64');
        return { kind: 'image', displayPath: safeDisplay, sizeBytes: bytes.byteLength, dataUrl: `data:${mime};base64,${base64}` };
    }
    const extracted = await attachmentToText(safeDisplay, bytes);
    if (extracted === null)
        throw new Error('Unsupported attachment type.');
    return { kind: 'text', displayPath: safeDisplay, sizeBytes: bytes.byteLength, text: extracted };
}
async function attachmentToText(displayPath, bytes) {
    const ext = (String(displayPath || '').split('.').pop() || '').toLowerCase();
    const buf = Buffer.from(bytes);
    const textLike = new Set([
        'txt',
        'md',
        'csv',
        'json',
        'yaml',
        'yml',
        'toml',
        'ini',
        'xml',
        'html',
        'css',
        'js',
        'ts',
        'tsx',
        'jsx',
        'py',
        'java',
        'cs',
        'go',
        'rs',
        'rb',
        'php',
        'sh',
        'ps1'
    ]);
    if (textLike.has(ext)) {
        const text = buf.toString('utf8');
        return `Attached file (text): ${displayPath}\n\n${text}`;
    }
    if (ext === 'pdf') {
        const res = await (0, pdf_parse_1.default)(buf);
        const text = String(res?.text || '').trim();
        return `Attached file (pdf -> text): ${displayPath}\n\n${text}`;
    }
    if (ext === 'xlsx' || ext === 'xls') {
        const wb = XLSX.read(buf, { type: 'buffer' });
        const names = (wb.SheetNames || []).slice(0, 3);
        const parts = [`Attached file (excel -> csv preview): ${displayPath}`];
        for (const name of names) {
            const sheet = wb.Sheets[name];
            if (!sheet)
                continue;
            const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
            parts.push(`--- Sheet: ${name} ---\n${csv.trim()}`);
        }
        return parts.join('\n\n');
    }
    if (ext === 'docx') {
        const res = await mammoth.extractRawText({ buffer: buf });
        const text = String(res?.value || '').trim();
        return `Attached file (docx -> text): ${displayPath}\n\n${text}`;
    }
    if (ext === 'pptx') {
        const zip = await jszip_1.default.loadAsync(buf);
        const slideXmlPaths = Object.keys(zip.files)
            .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
            .sort((a, b) => a.localeCompare(b));
        const texts = [];
        for (const p of slideXmlPaths.slice(0, 20)) {
            const xml = await zip.files[p].async('string');
            const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
            const slideText = matches
                .map((m) => m.replace(/^[\s\S]*?>/, '').replace(/<\/a:t>[\s\S]*$/, ''))
                .map((s) => s
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'"))
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (slideText)
                texts.push(`[${p}] ${slideText}`);
        }
        return `Attached file (pptx -> text): ${displayPath}\n\n${texts.join('\n')}`.trim();
    }
    // For unknown or binary file types, return a safe placeholder with metadata instead of null
    // so attachments are not skipped. This avoids sending raw binary data to the model.
    const size = Buffer.from(bytes).byteLength;
    return `Attached file (binary/unsupported -> placeholder): ${displayPath}\n\n- Type: ${ext || 'unknown'}\n- Size bytes: ${size}\n- Note: binary or unsupported file type; content not included.`;
}
//# sourceMappingURL=fileLoader.js.map