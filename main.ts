// mend: one command-line patch tool for every AI edit format.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. SPEC.md is the whole
// contract; where this file and SPEC.md seem to differ, SPEC.md decides.
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI above it.

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

/** A file as lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileDoc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** A line read at a matching tier (SPEC.md section 5): 0 exact, 1 trailing space/tab off, 2 both ends off. */
function tierLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where pat occurs in lines at one tier; occurrences may overlap. */
function occurrencesAt(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const np = pat.map((l) => tierLine(l, tier));
  const start = Math.max(0, from);
  for (let i = start; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (tierLine(lines[i + j]!, tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which pat occurs in lines at or after `from`, with its positions. */
function firstTier(lines: string[], pat: string[], from: number, maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrencesAt(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to anchor at the first tier with one (a single line both sides). */
function firstTierSingle(lines: string[], anchor: string, from: number, maxTier: number): number | null {
  for (let t = 0; t <= maxTier; t++) {
    const a = tierLine(anchor, t);
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (tierLine(lines[i]!, t) === a) return i;
    }
  }
  return null;
}

/** One line of a hunk or chunk body: ' ' context, '-' old, '+' new, '\\' a marker after the line before it. */
interface BodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** True when the patch line carrying this item is blank (empty or only whitespace). */
  blank: boolean;
  /** True when the patch line carrying this item is empty (zero characters). */
  empty: boolean;
}

function bodyItem(line: string): BodyItem {
  if (line === '') return { kind: ' ', text: '', blank: true, empty: true };
  const c = line[0]!;
  if (c === ' ') return { kind: ' ', text: line.slice(1), blank: line.trim() === '', empty: false };
  if (c === '-') return { kind: '-', text: line.slice(1), blank: false, empty: false };
  if (c === '+') return { kind: '+', text: line.slice(1), blank: false, empty: false };
  return { kind: '\\', text: line.slice(1), blank: false, empty: false };
}

/** The old lines of a body: its context and '-' lines, in body order. */
function oldLinesOf(items: BodyItem[]): string[] {
  return items.filter((it) => it.kind === ' ' || it.kind === '-').map((it) => it.text);
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/**
 * The lines a hunk or chunk writes for a match at `at`: a context line is the
 * file's own matched line, never the patch's; at tier 2 every other new line
 * is re-indented from the old lines' leading whitespace to the file's.
 */
function buildNew(items: BodyItem[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const o = oldLinesOf(items);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[at] ?? '');
    p = leadWs(o[0]!);
  }
  let oi = 0;
  for (const it of items) {
    if (it.kind === ' ') {
      out.push(fileLines[at + oi]!);
      oi++;
    } else if (it.kind === '-') {
      oi++;
    } else if (it.kind === '+') {
      let t = it.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** True when a `\` line follows the body's last context or `+` line. */
function noBreakAfter(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === ' ' || it.kind === '+') {
      return items[i + 1] !== undefined && items[i + 1]!.kind === '\\';
    }
  }
  return false;
}

/** One parsed edit: it changes the tree or throws a Fail; it reports the moves it made. */
type Edit = (tree: Tree) => { moves: Array<[string, string]> };

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
      return { moves: [] };
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
      return { moves: [] };
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
      return { moves: [] };
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A leading `a/` or `b/` is removed from a path a `--- ` or `+++ ` line names. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces off. */
function dashPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

interface SectionState {
  hunks: Hunk[];
  dashOld: string | null;
  dashNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hasHunk: boolean;
}

function freshSection(git: { old: string; new: string } | null): SectionState {
  return {
    hunks: [],
    dashOld: null,
    dashNew: null,
    renFrom: null,
    renTo: null,
    gitOld: git === null ? null : git.old,
    gitNew: git === null ? null : git.new,
    createFlag: false,
    deleteFlag: false,
    hasHunk: false,
  };
}

/** A `diff --git` line's paths, or a parse fault at its line when it is not of the form above. */
function diffGit(line: string, i: number): { old: string; new: string } {
  const m = DIFF_GIT_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return { old: m[1]!, new: m[2]! };
}

function resolveUniPath(raw: string | null, strip: boolean): string | null {
  if (raw === null) return null;
  const s = strip ? stripAB(raw) : raw;
  return s === '/dev/null' ? null : s;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: SectionState | null = null;
  let inBody = false;
  let curHunk: Hunk | null = null;

  const finishSection = (): void => {
    if (sec === null) return;
    const oldPath = sec.dashOld !== null
      ? resolveUniPath(sec.dashOld, true)
      : sec.renFrom !== null
        ? sec.renFrom
        : resolveUniPath(sec.gitOld, false);
    const newPath = sec.dashNew !== null
      ? resolveUniPath(sec.dashNew, true)
      : sec.renTo !== null
        ? sec.renTo
        : resolveUniPath(sec.gitNew, false);
    let kind: UniSection['kind'];
    if (sec.createFlag || oldPath === null) kind = 'create';
    else if (sec.deleteFlag || newPath === null) kind = 'delete';
    else if (oldPath !== newPath) kind = 'move';
    else kind = 'change';
    sections.push({ oldPath, newPath, kind, hunks: sec.hunks });
    sec = null;
  };
  const startSection = (git: { old: string; new: string } | null): void => {
    finishSection();
    sec = freshSection(git);
    inBody = false;
  };
  const endBody = (): void => {
    if (curHunk !== null) {
      // Empty lines at the end of a body are not part of it.
      while (curHunk.items.length > 0 && curHunk.items[curHunk.items.length - 1]!.empty) curHunk.items.pop();
    }
    curHunk = null;
    inBody = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      if (line.startsWith('diff --git ')) {
        endBody();
        startSection(diffGit(line, i));
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        startSection(null);
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curHunk!.items.push(bodyItem(line));
        i++;
        continue;
      }
      endBody();
      continue;
    }
    if (sec === null) {
      if (line.startsWith('diff --git ')) {
        startSection(diffGit(line, i));
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null);
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      startSection(diffGit(line, i));
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sec.hasHunk) {
          startSection(null);
          continue;
        }
        if (sec.dashOld === null) sec.dashOld = dashPath(line);
        if (sec.dashNew === null) sec.dashNew = dashPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (!sec.hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (sec.dashNew === null) sec.dashNew = dashPath(line);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: Number(m[1]), items: [] };
      sec.hunks.push(curHunk);
      sec.hasHunk = true;
      inBody = true;
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (sec.renFrom === null) sec.renFrom = line.slice('rename from '.length);
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (sec.renTo === null) sec.renTo = line.slice('rename to '.length);
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.createFlag = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.deleteFlag = true;
      i++;
      continue;
    }
    i++;
  }
  if (inBody) endBody();
  finishSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One hunk applied to a file: the nearest occurrence to A - 1 + d, or an insertion for an empty O. */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): FileDoc {
  const items = hunk.items;
  const o = oldLinesOf(items);
  if (o.length === 0) {
    const n = items.filter((it) => it.kind === '+').map((it) => it.text);
    const pos = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
    const lines = [...doc.lines.slice(0, pos), ...n, ...doc.lines.slice(pos)];
    const final = pos === doc.lines.length ? !noBreakAfter(items) : doc.final;
    return { lines, br: doc.br, final };
  }
  const found = firstTier(doc.lines, o, 0, strict ? 0 : 2);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const replacement = buildNew(items, doc.lines, best, found.tier);
  const lines = [...doc.lines.slice(0, best), ...replacement, ...doc.lines.slice(best + o.length)];
  const final = best + o.length === doc.lines.length ? !noBreakAfter(items) : doc.final;
  return { lines, br: doc.br, final };
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'create') {
      const p = s.newPath;
      if (p === null) throw new Fail('missing', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === '+') plus.push(it.text);
      let finalBreak = true;
      outer: for (let h = s.hunks.length - 1; h >= 0; h--) {
        const items = s.hunks[h]!.items;
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k]!.kind === '+') {
            finalBreak = !(items[k + 1] !== undefined && items[k + 1]!.kind === '\\');
            break outer;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return { moves: [] };
    }
    if (s.kind === 'delete') {
      const p = s.oldPath;
      if (p === null) throw new Fail('missing', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return { moves: [] };
    }
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP === null) throw new Fail('missing', '/dev/null');
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (s.kind === 'move') {
      if (newP === null) throw new Fail('missing', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (s.kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let doc = parseFile(cur);
    let d = 0;
    for (const h of s.hunks) {
      doc = applyHunk(doc, h, d, strict, oldP);
      const nLen = h.items.filter((it) => it.kind === ' ' || it.kind === '+').length;
      const oLen = h.items.filter((it) => it.kind === ' ' || it.kind === '-').length;
      d += nLen - oLen;
    }
    const text = serializeFile(doc);
    if (s.kind === 'move') {
      tree.now.set(newP!, text);
      tree.now.set(oldP, null);
      return { moves: [[oldP, newP!]] };
    }
    tree.now.set(oldP, text);
    return { moves: [] };
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE (SPEC.md section 7)                                  */
/* ------------------------------------------------------------------ */

interface SearchBlock {
  path: string;
  old: string[];
  new: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let i = 0;
  let lastEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let k = searchIdx - 1; k >= lastEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    i++;
    const old: string[] = [];
    let sep = false;
    while (i < lines.length && lines[i]!.trimEnd() !== '=======' && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
      old.push(lines[i]!);
      i++;
    }
    if (i >= lines.length || lines[i]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchIdx + 1}`);
    sep = true;
    i++;
    const nw: string[] = [];
    while (i < lines.length && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
      nw.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old, new: nw });
    lastEnd = i + 1;
    i++;
  }
  // A patch in which the reader finds no edit at all is `error: parse 1` (section 2); `error: format`
  // is only for auto-detection finding no format, which never reaches this parser.
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SearchBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return { moves: [] };
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const doc = parseFile(cur);
    // The old block is replaced outright: its lines are removed, not kept as context.
    const items: BodyItem[] = b.old.map((t) => ({ kind: '-', text: t }));
    const found = firstTier(doc.lines, b.old, 0, strict ? 0 : 2);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const nItems = b.new.map((t) => ({ kind: '+', text: t }));
    const replacement = buildNew([...items, ...nItems], doc.lines, at, found.tier);
    const lines = [...doc.lines.slice(0, at), ...replacement, ...doc.lines.slice(at + b.old.length)];
    tree.now.set(b.path, serializeFile({ lines, br: doc.br, final: doc.final }));
    return { moves: [] };
  };
}

/* ------------------------------------------------------------------ */
/* V4A (SPEC.md section 8)                                             */
/* ------------------------------------------------------------------ */

type V4aChunk = { anchor: string | null; items: BodyItem[]; eof: boolean };

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  /** Add File lines: `text` is the line of the file; `blank` is true when the patch line itself was empty. */
  lines: Array<{ text: string; blank: boolean }>;
  chunks: V4aChunk[];
}

function stripTrailingBlanks(items: BodyItem[]): BodyItem[] {
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === ' ' && last.text === '') items.pop();
    else if (last.kind === '+' && last.text === '') items.pop();
    else break;
  }
  return items;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  let sec: V4aSection | null = null;
  let curChunk: V4aChunk | null = null;
  const startSection = (kind: V4aSection['kind'], path: string, line: number): void => {
    if (sec !== null) sections.push(sec);
    sec = { kind, path, line, moveTo: null, lines: [], chunks: [] };
    curChunk = null;
  };
  const flushSection = (): void => {
    if (sec === null) return;
    if (sec.kind === 'update') {
      if (sec.chunks.length > 0) {
        const lastChunk = sec.chunks[sec.chunks.length - 1]!;
        lastChunk.items = stripTrailingBlanks(lastChunk.items);
      }
    }
    if (sec.kind === 'add') {
      // A lone `+` line is a line of the file, even when its text is empty; only a patch line that is
      // itself empty is a blank line, and blank lines at the end of a section are not part of it (section 8).
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1]!.blank) sec.lines.pop();
    }
    sections.push(sec);
    sec = null;
  };
  while (i < last) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      flushSection();
      startSection('add', line.slice('*** Add File: '.length).trim(), i + 1);
      i++;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      flushSection();
      startSection('delete', line.slice('*** Delete File: '.length).trim(), i + 1);
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      flushSection();
      startSection('update', line.slice('*** Update File: '.length).trim(), i + 1);
      i++;
      continue;
    }
    if (sec === null) {
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'add') {
      if (line.startsWith('+')) sec.lines.push({ text: line.slice(1), blank: false });
      else if (line === '') sec.lines.push({ text: '', blank: true });
      else throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (sec.kind === 'delete') {
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // update
    if (sec.moveTo === null && sec.chunks.length === 0 && line.startsWith('*** Move to: ')) {
      sec.moveTo = line.slice('*** Move to: '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      curChunk = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      sec.chunks.push(curChunk);
      i++;
      continue;
    }
    if (line === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
      curChunk.eof = true;
      curChunk = null;
      i++;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (curChunk === null) {
        if (sec.chunks.length === 0 && !blank(line)) {
          curChunk = { anchor: null, items: [], eof: false };
          sec.chunks.push(curChunk);
        } else if (sec.chunks.length > 0 && !blank(line)) {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      if (curChunk !== null) {
        curChunk.items.push(bodyItem(line));
      }
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  flushSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  for (const s of sections) {
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) {
      throw new Exit2(`error: parse ${s.line}`);
    }
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const texts = s.lines.map((l) => l.text);
      tree.now.set(s.path, texts.length === 0 ? '' : texts.join('\n') + '\n');
      return { moves: [] };
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return { moves: [] };
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let doc = parseFile(cur);
    let cursor = 0;
    for (const chunk of s.chunks) {
      const items = chunk.items;
      const o = oldLinesOf(items);
      if (chunk.anchor !== null) {
        const aFound = firstTierSingle(doc.lines, chunk.anchor, cursor, strict ? 0 : 2);
        if (aFound === null) throw new Fail('no-match', s.path);
        cursor = aFound + 1;
      }
      if (o.length === 0) {
        const n = items.filter((it) => it.kind === '+').map((it) => it.text);
        const pos = chunk.eof ? doc.lines.length : cursor;
        doc = {
          lines: [...doc.lines.slice(0, pos), ...n, ...doc.lines.slice(pos)],
          br: doc.br,
          final: doc.final,
        };
        cursor = pos + n.length;
        continue;
      }
      const found = firstTier(doc.lines, o, cursor, strict ? 0 : 2);
      if (found === null) throw new Fail('no-match', s.path);
      if (chunk.eof) {
        const ends = found.occ.filter((p) => p + o.length === doc.lines.length);
        if (ends.length === 0) throw new Fail('no-match', s.path);
        const at = ends[0]!;
        const replacement = buildNew(items, doc.lines, at, found.tier);
        doc = {
          lines: [...doc.lines.slice(0, at), ...replacement, ...doc.lines.slice(at + o.length)],
          br: doc.br,
          final: doc.final,
        };
        cursor = at + replacement.length;
        continue;
      }
      // The cursor disambiguates: the first occurrence at or after it wins.
      const at = found.occ[0]!;
      const replacement = buildNew(items, doc.lines, at, found.tier);
      doc = {
        lines: [...doc.lines.slice(0, at), ...replacement, ...doc.lines.slice(at + o.length)],
        br: doc.br,
        final: doc.final,
      };
      cursor = at + replacement.length;
    }
    const text = serializeFile(doc);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, text);
      tree.now.set(s.path, null);
      return { moves: [[s.path, s.moveTo]] };
    }
    tree.now.set(s.path, text);
    return { moves: [] };
  };
}

/* ------------------------------------------------------------------ */
/* The command line (SPEC.md section 1)                                */
/* ------------------------------------------------------------------ */

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
  let edits: Edit[];
  try {
    edits = kind === 'json'
      ? jsonEdits(text, lines)
      : kind === 'unified'
        ? parseUnified(lines, strict)
        : kind === 'search-replace'
          ? parseSearchReplace(lines, strict)
          : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const r = edit(tree);
      moves.push(...r.moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
