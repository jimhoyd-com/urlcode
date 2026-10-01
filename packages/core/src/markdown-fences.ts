/**
 * Fenced code blocks in Markdown, one rule set shared by every Markdown reader (docs search's `headingsOf` among them;
 * #826, #1118). The rules are CommonMark's, for a fence at the top level of a document:
 * - a run of at least three backticks or tildes, indented at most three spaces, opens a fence; the rest of the line is
 *   its info string, and a backtick fence's info string may not contain a backtick (that line is inline code instead);
 * - only a run of the same character, at least as long as the opener, indented at most three spaces and followed by
 *   nothing but whitespace, closes it; any other line, a shorter run or the other character included, is content;
 * - a fence that never closes runs to the end of the document.
 * A trailing carriage return is whitespace, so CRLF sources read the same. Container blocks (a fence inside a list
 * item or block quote, whose indentation is relative to the container) are not modelled.
 */
export interface Fence { char: '`' | '~'; length: number; info: string }

const RUN = /^ {0,3}(`{3,}|~{3,})(.*?)\r?$/;

/** The fence `line` opens, or undefined when it opens none. */
export function fenceOpening(line: string): Fence | undefined {
  const run = RUN.exec(line);
  if (!run) return undefined;
  const marker = run[1]!, info = run[2]!;
  if (marker[0] === '`' && info.includes('`')) return undefined;
  return { char: marker[0] as Fence['char'], length: marker.length, info: info.trim() };
}

/** Whether `line` closes the open `fence`. */
export function closesFence(line: string, fence: Fence): boolean {
  const run = RUN.exec(line);
  return run !== null && run[1]![0] === fence.char && run[1]!.length >= fence.length && /^[ \t]*$/.test(run[2]!);
}

/** The first word of a fence's info string: its language, lowercased (`yaml` for ```` ```yaml title="x" ````). */
export const fenceLanguage = (fence: Fence): string => (/^\S*/.exec(fence.info)?.[0] ?? '').toLowerCase();

/**
 * What each line of a Markdown source is, in order: `text` outside any fence, `open` and `close` for the fence lines,
 * `content` inside. Lines are split on `\n`, so the result is index-aligned with `source.split('\n')`.
 */
export type FenceLine = { kind: 'text'; fence?: undefined } | { kind: 'open' | 'content' | 'close'; fence: Fence };
export function fenceLines(source: string): FenceLine[] {
  const lines: FenceLine[] = [];
  let fence: Fence | undefined;
  for (const line of source.split('\n')) {
    if (fence) {
      lines.push({ kind: closesFence(line, fence) ? 'close' : 'content', fence });
      if (lines.at(-1)!.kind === 'close') fence = undefined;
      continue;
    }
    fence = fenceOpening(line);
    lines.push(fence ? { kind: 'open', fence } : { kind: 'text' });
  }
  return lines;
}
