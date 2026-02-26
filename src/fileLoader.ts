import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import pdfParse from 'pdf-parse';
import * as XLSX from 'xlsx';
import * as mammoth from 'mammoth';
import JSZip from 'jszip';

export type LoadedAttachment =
  | { kind: 'image'; displayPath: string; sizeBytes: number; dataUrl: string }
  | { kind: 'text'; displayPath: string; sizeBytes: number; text: string };

export function expandHome(p: string): string {
  const s = String(p || '').trim();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

export function looksSensitivePath(p: string): boolean {
  const s = String(p || '').toLowerCase();
  return (
    s.endsWith('.env') ||
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
    s.includes(path.sep + '.git' + path.sep)
  );
}

export function isAbsoluteUserPath(p: string): boolean {
  const s = String(p || '').trim();
  if (!s) return false;
  if (s.startsWith('/')) return true; // unix/mac
  if (/^[A-Za-z]:\\/.test(s)) return true; // windows
  if (s.startsWith('~/')) return true; // home expansion
  return false;
}

export async function loadFromAbsolutePath(absPath: string, opts: { maxBytes: number }): Promise<LoadedAttachment> {
  const expanded = expandHome(absPath);
  if (!isAbsoluteUserPath(absPath)) {
    throw new Error('Path must be absolute (or start with ~/).');
  }
  const st = await fs.stat(expanded);
  if (!st.isFile()) throw new Error('Path is not a file.');
  if (st.size > opts.maxBytes) throw new Error(`File too large (${st.size} bytes).`);
  const bytes = await fs.readFile(expanded);
  return loadFromBytes(path.basename(expanded), expanded, bytes, { maxBytes: opts.maxBytes });
}

export async function loadFromBytes(
  fileName: string,
  displayPath: string,
  bytes: Uint8Array,
  opts: { maxBytes: number }
): Promise<LoadedAttachment> {
  const safeDisplay = String(displayPath || fileName || 'attachment');
  if (looksSensitivePath(safeDisplay)) throw new Error('Blocked by sensitive-path policy.');
  if (bytes.byteLength > opts.maxBytes) throw new Error(`File too large (${bytes.byteLength} bytes).`);

  const ext = (safeDisplay.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
    const mime =
      ext === 'jpg' || ext === 'jpeg'
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
  if (extracted === null) throw new Error('Unsupported attachment type.');
  return { kind: 'text', displayPath: safeDisplay, sizeBytes: bytes.byteLength, text: extracted };
}

export async function attachmentToText(displayPath: string, bytes: Uint8Array): Promise<string | null> {
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
    const res = await pdfParse(buf);
    const text = String(res?.text || '').trim();
    return `Attached file (pdf -> text): ${displayPath}\n\n${text}`;
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const names = (wb.SheetNames || []).slice(0, 3);
    const parts: string[] = [`Attached file (excel -> csv preview): ${displayPath}`];
    for (const name of names) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
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
    const zip = await JSZip.loadAsync(buf);
    const slideXmlPaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
      .sort((a, b) => a.localeCompare(b));
    const texts: string[] = [];
    for (const p of slideXmlPaths.slice(0, 20)) {
      const xml = await zip.files[p].async('string');
      const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
      const slideText = matches
        .map((m) => m.replace(/^[\s\S]*?>/, '').replace(/<\/a:t>[\s\S]*$/, ''))
        .map((s) =>
          s
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
        )
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (slideText) texts.push(`[${p}] ${slideText}`);
    }
    return `Attached file (pptx -> text): ${displayPath}\n\n${texts.join('\n')}`.trim();
  }

  // For unknown or binary file types, return a safe placeholder with metadata instead of null
  // so attachments are not skipped. This avoids sending raw binary data to the model.
  const size = Buffer.from(bytes).byteLength;
  return `Attached file (binary/unsupported -> placeholder): ${displayPath}\n\n- Type: ${ext || 'unknown'}\n- Size bytes: ${size}\n- Note: binary or unsupported file type; content not included.`;
}
