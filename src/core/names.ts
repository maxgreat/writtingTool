/**
 * Name detection: one Aho-Corasick automaton built from every sheet name and
 * alias, run over a paragraph at a time. The rules come from the development
 * guide: whole words only, longest match wins, apostrophes are word edges and
 * straight and curly ones match alike, text is Unicode-normalized, names are
 * case-sensitive unless an alias opts out, and an alias shared by two sheets
 * is reported as ambiguous.
 */

export interface NamePattern {
  text: string;
  sheetId: string;
  kind: string;
  ignoreCase: boolean;
}

export interface NameMatch {
  /** Offsets into the text passed to `find`, in UTF-16 code units. */
  from: number;
  to: number;
  sheetIds: string[];
  /** Kind of the first sheet (for example "characters" or "places"). */
  kind: string;
  ambiguous: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const COMBINING_MARK = /\p{M}/u;
const APOSTROPHES = /[’ʼ]/gu;

/** NFC with all apostrophes made straight. */
function normalizePattern(text: string): string {
  return text.trim().normalize("NFC").replace(APOSTROPHES, "'");
}

/**
 * Lower-cases one code point at a time, keeping any character whose lower
 * case has a different length, so offsets stay the same as in the input.
 */
function foldCase(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

interface Prepared {
  text: string;
  /** Original offset where the cluster of each normalized code unit starts. */
  start: number[];
  /** Original offset just after that cluster. */
  end: number[];
}

/**
 * Normalizes text to NFC one base-plus-combining-marks cluster at a time and
 * records where each normalized code unit came from, so match offsets can be
 * mapped back to the text the editor holds.
 */
function prepare(input: string): Prepared {
  const start: number[] = [];
  const end: number[] = [];
  let text = "";
  let i = 0;
  while (i < input.length) {
    const clusterStart = i;
    i += input.codePointAt(i)! > 0xffff ? 2 : 1;
    while (i < input.length) {
      const cp = input.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      if (!COMBINING_MARK.test(ch)) break;
      i += ch.length;
    }
    const cluster = input
      .slice(clusterStart, i)
      .normalize("NFC")
      .replace(APOSTROPHES, "'");
    for (let k = 0; k < cluster.length; k++) {
      start.push(clusterStart);
      end.push(i);
    }
    text += cluster;
  }
  return { text, start, end };
}

function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const code = text.charCodeAt(index - 1);
  const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
  return isLowSurrogate && index >= 2 ? text.slice(index - 2, index) : text[index - 1];
}

function charAt(text: string, index: number): string {
  if (index >= text.length) return "";
  return String.fromCodePoint(text.codePointAt(index)!);
}

function isWholeWord(text: string, from: number, to: number): boolean {
  return !WORD_CHAR.test(charBefore(text, from)) && !WORD_CHAR.test(charAt(text, to));
}

/** A plain Aho-Corasick automaton over UTF-16 code units. */
class Automaton {
  private next: Map<string, number>[] = [new Map()];
  private fail: number[] = [0];
  private out: number[][] = [[]];
  readonly lengths: number[] = [];

  add(pattern: string, id: number): void {
    let node = 0;
    for (const ch of pattern) {
      for (const unit of ch.length === 1 ? [ch] : [ch[0], ch[1]]) {
        let child = this.next[node].get(unit);
        if (child === undefined) {
          child = this.next.length;
          this.next.push(new Map());
          this.fail.push(0);
          this.out.push([]);
          this.next[node].set(unit, child);
        }
        node = child;
      }
    }
    this.out[node].push(id);
    this.lengths[id] = pattern.length;
  }

  build(): void {
    const queue: number[] = [];
    for (const child of this.next[0].values()) queue.push(child);
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [unit, child] of this.next[node]) {
        let f = this.fail[node];
        while (f !== 0 && !this.next[f].has(unit)) f = this.fail[f];
        const target = this.next[f].get(unit);
        this.fail[child] = target !== undefined && target !== child ? target : 0;
        this.out[child] = this.out[child].concat(this.out[this.fail[child]]);
        queue.push(child);
      }
    }
  }

  /** Calls `hit(patternId, endExclusive)` for every occurrence. */
  scan(text: string, hit: (id: number, end: number) => void): void {
    let node = 0;
    for (let i = 0; i < text.length; i++) {
      const unit = text[i];
      while (node !== 0 && !this.next[node].has(unit)) node = this.fail[node];
      node = this.next[node].get(unit) ?? 0;
      for (const id of this.out[node]) hit(id, i + 1);
    }
  }
}

interface Candidate {
  from: number;
  to: number;
  sheetIds: string[];
  kind: string;
}

export class NameMatcher {
  private readonly exact = new Automaton();
  private readonly folded = new Automaton();
  private readonly patterns: NamePattern[] = [];
  readonly size: number;

  constructor(patterns: NamePattern[]) {
    for (const p of patterns) {
      const text = normalizePattern(p.text);
      if (text === "") continue;
      const id = this.patterns.length;
      this.patterns.push({ ...p, text });
      if (p.ignoreCase) this.folded.add(foldCase(text), id);
      else this.exact.add(text, id);
    }
    this.exact.build();
    this.folded.build();
    this.size = this.patterns.length;
  }

  find(input: string): NameMatch[] {
    if (this.size === 0 || input === "") return [];
    const { text, start, end } = prepare(input);

    const bySpan = new Map<string, Candidate>();
    const hit = (lengths: number[]) => (id: number, to: number) => {
      const from = to - lengths[id];
      if (!isWholeWord(text, from, to)) return;
      const p = this.patterns[id];
      const key = `${from}:${to}`;
      const existing = bySpan.get(key);
      if (!existing) {
        bySpan.set(key, { from, to, sheetIds: [p.sheetId], kind: p.kind });
      } else if (!existing.sheetIds.includes(p.sheetId)) {
        existing.sheetIds.push(p.sheetId);
      }
    };
    this.exact.scan(text, hit(this.exact.lengths));
    this.folded.scan(foldCase(text), hit(this.folded.lengths));

    // Leftmost first; at the same start, longest first. Then keep matches
    // that don't overlap one already kept, so the longest name wins.
    const sorted = [...bySpan.values()].sort((a, b) => a.from - b.from || b.to - a.to);
    const result: NameMatch[] = [];
    let lastEnd = 0;
    for (const c of sorted) {
      if (c.from < lastEnd) continue;
      lastEnd = c.to;
      result.push({
        from: start[c.from],
        to: end[c.to - 1],
        sheetIds: c.sheetIds,
        kind: c.kind,
        ambiguous: c.sheetIds.length > 1,
      });
    }
    return result;
  }
}
