// static-site-faster: the program the harness runs (node /bot/main.ts, node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

/**
 * The answers as one JSON string, written by hand instead of JSON.stringify:
 * each answer is an object of path -> text, so one JSON.stringify per string
 * plus a join is measurably faster than stringifying the whole tree at once,
 * and produces byte-identical output (verified against JSON.stringify).
 * A value JSON.stringify would drop (undefined, a function, a symbol) is
 * dropped here too, as it is there.
 */
function stringifyAnswers(list: unknown[]): string {
  const parts: string[] = ['['];
  for (let i = 0; i < list.length; i++) {
    if (i > 0) parts.push(',');
    parts.push('{');
    let first = true;
    for (const k of Object.keys(list[i] as Record<string, unknown>)) {
      const v = JSON.stringify((list[i] as Record<string, unknown>)[k]);
      if (v === undefined) continue;
      if (!first) parts.push(',');
      first = false;
      parts.push(JSON.stringify(k), ':', v);
    }
    parts.push('}');
  }
  parts.push(']');
  return parts.join('');
}

writeFileSync(join(OUTPUT_DIR, 'answers.json'), stringifyAnswers(answers));
