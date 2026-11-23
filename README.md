# static-site-faster

A fast drop-in for make.fun's own static site generator, makefun-site 1.0.0. `solve.js` answers every case exactly as makefun-site does — the same output tree, byte for byte — but faster: its Markdown inline renderer works on runs of plain text instead of escaping one character at a time, its block lexer checks line prefixes by hand instead of running several regular expressions per line, slugs are memoised per case, and its front-matter parser scans lines directly. `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json`.

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/syamscelot1/static-site-faster/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/syamscelot1/static-site-faster/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Entry for the make.fun competition [Build a static site faster](https://make.fun/competitions/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) (`site-generator-speed-01-run-20261122`).

## Layout

- `solve.js` — the entrypoint: `run(input)` returns the output tree for one site, a JSON object of every path it writes and that file's text.
- `main.ts` — the driver: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.
- `LICENSE` — MIT.

## Run locally

```sh
MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=path/to/output node main.ts
```

Node 22 or later, nothing to install, no network needed.
