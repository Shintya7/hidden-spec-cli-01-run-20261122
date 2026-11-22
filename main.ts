// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
// It implements all of SPEC.md: section 1 the command line, section 2 the output and exit codes,
// section 3 files, lines and paths, section 4 format detection, section 5 three-tier line
// matching, section 6 unified diffs, section 7 SEARCH/REPLACE blocks, section 8 V4A patches,
// section 9 JSON edits and section 10 order and atomicity. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a line break (section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** One body line of a hunk or chunk: a context line, an old line, a new line, or a `\` line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** A move an edit made, for the `R` output line (section 2). */
interface Move {
  old: string;
  new: string;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- section 5: matching lines ----

const trimRight = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRight(a) === trimRight(b);
  return trimBoth(a) === trimBoth(b);
}

/** 0-based positions where O occurs in lines at the given tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier at which O occurs at least once (tier 0 only when strict), with that tier's
 * occurrences; tier -1 and no occurrences when O occurs at no tier.
 */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return { tier: -1, occ: [] };
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A non-context new line at tier 2, re-indented from O's indent P to the file's indent F. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/**
 * The lines a hunk or chunk writes: context lines as the file's own matched lines, old lines
 * dropped, new lines as the patch wrote them (re-indented at tier 2). `pos` is the 0-based
 * position of the matched occurrence, or the insertion point when O is empty.
 */
function applyBody(lines: string[], pos: number, body: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  let oIdx = 0;
  let doRe = false;
  let p = '';
  let f = '';
  if (tier === 2) {
    const firstO = body.find((b) => b.kind === 'ctx' || b.kind === 'old');
    if (firstO !== undefined) {
      doRe = true;
      p = leadingWs(firstO.text);
      f = pos < lines.length ? leadingWs(lines[pos]!) : '';
    }
  }
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(lines[pos + oIdx]!);
      oIdx++;
    } else if (b.kind === 'old') {
      oIdx++;
    } else if (b.kind === 'new') {
      out.push(doRe ? reindent(b.text, p, f) : b.text);
    }
  }
  return out;
}

/** True when a `\` line follows the hunk's last context or `+` line (section 6). */
function hunkNoBreak(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') last = j;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bs';
}

// ---- section 9: JSON edits ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  gitOld?: string;
  gitNew?: string;
  dashOld?: string;
  dashNew?: string;
  renOld?: string;
  renNew?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function parseDiffGit(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  const x = rest.slice(0, k);
  const y = rest.slice(k + 3).trim();
  if (x === '' || y === '') return null;
  return [x, y];
}

/** A `--- <path>` or `+++ <path>` line's path: up to the first tab, trimmed, prefix removed. */
function dashPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function toBodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'old', text: line.slice(1) };
  if (c === '+') return { kind: 'new', text: line.slice(1) };
  return { kind: 'bs', text: line };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;

  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
      hunk = null;
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const no = idx + 1;
    const next = lines[idx + 1];
    if (hunk !== null) {
      if (isDiffGitLine(line)) {
        closeHunk();
        const p = parseDiffGit(line);
        if (p === null) throw new Exit2(`error: parse ${no}`);
        sec = { gitOld: p[0], gitNew: p[1], create: false, del: false, hunks: [] };
        sections.push(sec);
        inHeader = true;
        continue;
      }
      if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
        closeHunk();
        sec = { dashOld: dashPath(line), dashNew: dashPath(next), create: false, del: false, hunks: [] };
        sections.push(sec);
        inHeader = true;
        idx++;
        continue;
      }
      if (line.startsWith('@@')) {
        closeHunk();
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${no}`);
        hunk = { a: Number(m[1]), body: [] };
        inHeader = false;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk.body.push(toBodyLine(line));
        continue;
      }
      closeHunk();
    }
    if (isDiffGitLine(line)) {
      const p = parseDiffGit(line);
      if (p === null) throw new Exit2(`error: parse ${no}`);
      sec = { gitOld: p[0], gitNew: p[1], create: false, del: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${no}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      hunk = { a: Number(m[1]), body: [] };
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (inHeader && sec !== null) {
        if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${no + 1}`);
        sec.dashOld = dashPath(line);
        sec.dashNew = dashPath(next);
        idx++;
        continue;
      }
      if (next !== undefined && next.startsWith('+++ ')) {
        sec = { dashOld: dashPath(line), dashNew: dashPath(next), create: false, del: false, hunks: [] };
        sections.push(sec);
        inHeader = true;
        idx++;
        continue;
      }
      continue;
    }
    if (inHeader && sec !== null) {
      if (line.startsWith('+++ ')) {
        sec.dashNew = dashPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renOld = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renNew = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        continue;
      }
      continue;
    }
  }
  closeHunk();
  return sections.map((s) => makeUnifiedEdit(s, strict, moves));
}

/** Apply one hunk to a file model, honouring the `d` offset from hunks applied so far. */
function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): FileModel {
  const o = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
  if (o.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), model.lines.length);
    const inserted = applyBody(model.lines, at, h.body, -1);
    const lines = [...model.lines.slice(0, at), ...inserted, ...model.lines.slice(at)];
    let final = model.final;
    if (at === model.lines.length) final = !hunkNoBreak(h.body);
    return { br: model.br, lines, final };
  }
  const found = findTier(model.lines, o, strict);
  if (found.tier < 0) throw new Fail('no-match', path);
  const tier = found.tier;
  const occ = found.occ;
  const target = h.a - 1 + d;
  let pos = occ[0]!;
  let best = Math.abs(pos - target);
  for (const q of occ) {
    const dd = Math.abs(q - target);
    if (dd < best) {
      pos = q;
      best = dd;
    }
  }
  const replaced = applyBody(model.lines, pos, h.body, tier);
  const lines = [...model.lines.slice(0, pos), ...replaced, ...model.lines.slice(pos + o.length)];
  let final = model.final;
  if (pos + o.length === model.lines.length) final = !hunkNoBreak(h.body);
  return { br: model.br, lines, final };
}

function makeUnifiedEdit(sec: UniSection, strict: boolean, moves: Move[]): Edit {
  const pair = sec.dashOld !== undefined && sec.dashNew !== undefined;
  const oldRaw = pair ? sec.dashOld! : (sec.renOld ?? sec.dashOld ?? sec.gitOld);
  const newRaw = pair ? sec.dashNew! : (sec.renNew ?? sec.dashNew ?? sec.gitNew);
  const oldPath = oldRaw === undefined || oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === undefined || newRaw === '/dev/null' ? null : newRaw;
  const isCreate = oldPath === null || sec.create;
  const isDelete = !isCreate && (newPath === null || sec.del);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;

  if (isCreate) {
    const p = newPath;
    return (tree) => {
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'new') added.push(b.text);
        let lastNew = -1;
        for (let j = 0; j < h.body.length; j++) if (h.body[j]!.kind === 'new') lastNew = j;
        if (lastNew >= 0) noBreak = h.body[lastNew + 1]?.kind === 'bs';
      }
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldPath!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const oldP = oldPath!;
  const newP = isMove ? newPath! : oldPath!;
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let model = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const oLen = h.body.reduce((n, b) => n + (b.kind === 'ctx' || b.kind === 'old' ? 1 : 0), 0);
      const nLen = h.body.reduce((n, b) => n + (b.kind === 'ctx' || b.kind === 'new' ? 1 : 0), 0);
      model = applyHunk(model, h, d, strict, oldP);
      d += nLen - oLen;
    }
    const text = joinFile(model);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      moves.push({ old: oldP, new: newP });
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// ---- section 7: SEARCH/REPLACE blocks ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => makeSREdit(b, strict));
}

function makeSREdit(b: SRBlock, strict: boolean): Edit {
  const p = b.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = splitFile(before);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found.tier < 0) throw new Fail('no-match', p);
    const tier = found.tier;
    const occ = found.occ;
    if (occ.length > 1) throw new Fail('ambiguous', p);
    const pos = occ[0]!;
    let newLines = b.newLines;
    if (tier === 2) {
      const pp = leadingWs(b.oldLines[0]!);
      const ff = leadingWs(model.lines[pos]!);
      newLines = b.newLines.map((l) => reindent(l, pp, ff));
    }
    const lines = [...model.lines.slice(0, pos), ...newLines, ...model.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinFile({ br: model.br, lines, final: model.final }));
  };
}

// ---- section 8: V4A patches ----

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let sec: V4ASection | null = null;
  let chunk: V4AChunk | null = null;
  let pendingBlanks = 0;
  let contentSeen = false;

  // Blank lines inside a section are content (an empty file line, or an empty context line);
  // they only survive when more content of the same section follows them.
  const flushBlanks = (): void => {
    if (sec === null || pendingBlanks === 0) {
      pendingBlanks = 0;
      return;
    }
    if (sec.kind === 'add') {
      for (let k = 0; k < pendingBlanks; k++) sec.addLines.push('');
    } else if (sec.kind === 'update') {
      if (chunk === null && sec.chunks.length === 0) {
        chunk = { anchor: null, eof: false, body: [] };
        sec.chunks.push(chunk);
      }
      if (chunk !== null) {
        for (let k = 0; k < pendingBlanks; k++) chunk.body.push({ kind: 'ctx', text: '' });
      }
    }
    pendingBlanks = 0;
  };
  const closeSection = (): void => {
    pendingBlanks = 0;
    sec = null;
    chunk = null;
    contentSeen = false;
  };

  for (let idx = first + 1; idx < last; idx++) {
    const line = lines[idx]!;
    const no = idx + 1;
    if (blank(line)) {
      if (sec !== null) {
        pendingBlanks++;
        contentSeen = true;
      }
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      closeSection();
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
      const pfx = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      sec = { kind, path: line.slice(pfx.length).trim(), moveTo: null, addLines: [], chunks: [], updateLine: no };
      sections.push(sec);
      chunk = null;
      pendingBlanks = 0;
      contentSeen = false;
      continue;
    }
    if (sec === null) throw new Exit2(`error: parse ${no}`);
    if (sec.kind === 'add') {
      if (line.startsWith('+')) {
        flushBlanks();
        sec.addLines.push(line.slice(1));
        contentSeen = true;
        continue;
      }
      throw new Exit2(`error: parse ${no}`);
    }
    if (sec.kind === 'delete') {
      throw new Exit2(`error: parse ${no}`);
    }
    if (line.startsWith('*** Move to: ')) {
      if (contentSeen) throw new Exit2(`error: parse ${no}`);
      sec.moveTo = line.slice('*** Move to: '.length).trim();
      contentSeen = true;
      continue;
    }
    if (line.startsWith('@@')) {
      flushBlanks();
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      sec.chunks.push(chunk);
      contentSeen = true;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${no}`);
      flushBlanks();
      chunk.eof = true;
      chunk = null;
      contentSeen = true;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      flushBlanks();
      if (chunk === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        chunk = { anchor: null, eof: false, body: [] };
        sec.chunks.push(chunk);
      }
      chunk.body.push(toBodyLine(line));
      contentSeen = true;
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  closeSection();
  for (const s of sections) {
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) {
      throw new Exit2(`error: parse ${s.updateLine}`);
    }
  }
  return sections.map((s) => makeV4AEdit(s, strict, moves));
}

/** Apply one V4A chunk to a file model, moving the cursor past the lines written. */
function applyV4AChunk(model: FileModel, chunk: V4AChunk, cursor: number, strict: boolean, path: string): { model: FileModel; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    let found = -1;
    const maxTier = strict ? 0 : 2;
    for (let t = 0; t <= maxTier && found < 0; t++) {
      for (let j = cur; j < model.lines.length; j++) {
        if (lineEq(model.lines[j]!, chunk.anchor, t)) {
          found = j;
          break;
        }
      }
    }
    if (found < 0) throw new Fail('no-match', path);
    cur = found + 1;
  }
  const o = chunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
  if (o.length === 0) {
    const at = chunk.eof ? model.lines.length : cur;
    const inserted = applyBody(model.lines, at, chunk.body, -1);
    const lines = [...model.lines.slice(0, at), ...inserted, ...model.lines.slice(at)];
    return { model: { br: model.br, lines, final: model.final }, cursor: at + inserted.length };
  }
  let tier = -1;
  let pos = -1;
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(model.lines, o, t, cur);
    if (occ.length === 0) continue;
    tier = t;
    if (chunk.eof) {
      const e = occ.find((p) => p + o.length === model.lines.length);
      if (e === undefined) {
        tier = -1;
        pos = -1;
      } else {
        pos = e;
      }
    } else {
      pos = occ[0]!;
    }
    break;
  }
  if (tier < 0 || pos < 0) throw new Fail('no-match', path);
  const replaced = applyBody(model.lines, pos, chunk.body, tier);
  const lines = [...model.lines.slice(0, pos), ...replaced, ...model.lines.slice(pos + o.length)];
  return { model: { br: model.br, lines, final: model.final }, cursor: pos + replaced.length };
}

function makeV4AEdit(sec: V4ASection, strict: boolean, moves: Move[]): Edit {
  const p = sec.path;
  if (sec.kind === 'add') {
    const addLines = sec.addLines;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4AChunk(model, chunk, cursor, strict, p);
      model = r.model;
      cursor = r.cursor;
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      moves.push({ old: p, new: moveTo });
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- section 10: order and atomicity, and section 2: output and exit codes ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict, moves)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveByNew = new Map<string, string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      moveByNew.set(m.new, m.old);
    }
  }
  const rOlds = new Set(moveByNew.values());
  const rows: { key: string; text: string }[] = [];
  const changed: string[] = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveByNew.has(p)) {
      rows.push({ key: p, text: `R ${moveByNew.get(p)} -> ${p}` });
      continue;
    }
    if (rOlds.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null && tree.original(p) !== now) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
