export type UnifiedDiff = {
  added: number;
  removed: number;
  text: string;
};

type Edit =
  | { type: 'equal'; lines: string[] }
  | { type: 'insert'; lines: string[] }
  | { type: 'delete'; lines: string[] };

// Myers diff for arrays of strings (lines).
function myersDiff(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Array<Map<number, number>> = [];

  for (let d = 0; d <= max; d++) {
    const vNew = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      vNew.set(k, x);
      if (x >= n && y >= m) {
        trace.push(vNew);
        return backtrack(a, b, trace);
      }
    }
    trace.push(vNew);
    v.clear();
    for (const [k, x] of vNew.entries()) v.set(k, x);
  }
  return [{ type: 'delete', lines: a }, { type: 'insert', lines: b }];
}

function backtrack(a: string[], b: string[], trace: Array<Map<number, number>>): Edit[] {
  let x = a.length;
  let y = b.length;
  const edits: Array<{ op: 'equal' | 'insert' | 'delete'; line: string }> = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      edits.push({ op: 'equal', line: a[x - 1] });
      x--;
      y--;
    }

    if (d === 0) break;

    if (x === prevX) {
      edits.push({ op: 'insert', line: b[y - 1] });
      y--;
    } else {
      edits.push({ op: 'delete', line: a[x - 1] });
      x--;
    }
  }

  edits.reverse();
  const out: Edit[] = [];
  let cur: Edit | null = null;
  for (const e of edits) {
    const type = e.op;
    if (!cur || cur.type !== type) {
      cur = { type, lines: [] } as any;
      out.push(cur as Edit);
    }
    (cur as any).lines.push(e.line);
  }
  return out;
}

export function unifiedDiff(oldText: string, newText: string, filePath: string): UnifiedDiff {
  const a = String(oldText ?? '').replace(/\r\n/g, '\n').split('\n');
  const b = String(newText ?? '').replace(/\r\n/g, '\n').split('\n');
  const edits = myersDiff(a, b);

  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e.type === 'insert') added += e.lines.length;
    if (e.type === 'delete') removed += e.lines.length;
  }

  // Minimal unified diff: we output all edits as one hunk with no fancy context grouping.
  // This is still a valid "combined unified diff" experience for review.
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -1,${a.length} +1,${b.length} @@`);
  for (const e of edits) {
    if (e.type === 'equal') {
      for (const l of e.lines) lines.push(` ${l}`);
    } else if (e.type === 'delete') {
      for (const l of e.lines) lines.push(`-${l}`);
    } else if (e.type === 'insert') {
      for (const l of e.lines) lines.push(`+${l}`);
    }
  }

  return { added, removed, text: lines.join('\n') };
}
