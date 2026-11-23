// static-site-faster: a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input, byte for byte, but computed faster: the
// Markdown inline renderer works on runs of plain text instead of escaping
// one character at a time, the block lexer checks line prefixes by hand
// instead of running several regular expressions per line, slugs are
// memoised per case, and the front-matter parser scans lines directly.
// No code is copied from makefun-site; the behaviour was reimplemented
// from its README and verified against its practice answers.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

/** The scan for the next inline-significant character, shared by every inline() call: each call resets its lastIndex on entry, and every path that consumes a construct sets it again before continuing, so the recursion into strong, emphasis and link text never disturbs the scan it suspends. */
const INLINE_SCAN = /[\\`*\[&<>"']/g;
/** Whether a string holds a character HTML escaping must replace. */
const HAS_ESCAPE = /[&<>"']/;
/** Whether a one-character string is whitespace. */
const HAS_WS = /\s/;

/** `text` with & < > " and ' escaped. */
export function escapeHtml(s) {
  // A native test first: most strings hold nothing to escape, and the
  // test answers that in one native scan.
  if (!HAS_ESCAPE.test(s)) return s;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  let out = s.slice(0, i);
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, uncached. NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  // An all-ASCII string is unchanged by NFKD and holds no combining marks.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** A slugify memoised for one case (a cache inside one case is allowed; nothing is kept between cases). */
function makeSlugify() {
  const cache = new Map();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const slug = slugifySlow(text);
    cache.set(text, slug);
    return slug;
  };
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out;
  do { out = `${slug}-${n++}`; } while (taken.has(out));
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. The
 * whitespace set is JavaScript's \s exactly: \t \n \v \f \r space \u00a0
 * \u1680 \u2000-\u200a \u2028 \u2029 \u202f \u205f \u3000 \ufeff. ASCII text,
 * the usual case, takes the short check; the rest takes the full set.
 */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      if (c === 32 || (c >= 9 && c <= 13)) { inWord = false; continue; }
    } else if (c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) {
      inWord = false;
      continue;
    }
    if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** Whether `line` holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        out += n;
        i++;
      } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return fmString(key, raw);
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERR };
      let y = 0;
      let m = 0;
      let d = 0;
      for (let i = 0; i < 4; i++) {
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: DATE_ERR };
        y = y * 10 + (c - 48);
      }
      for (let i = 5; i < 7; i++) {
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: DATE_ERR };
        m = m * 10 + (c - 48);
      }
      for (let i = 8; i < 10; i++) {
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: DATE_ERR };
        d = d * 10 + (c - 48);
      }
      if (y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return { error: DATE_ERR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n" line ends.
 * The text is walked line by line with indexOf, so neither the whole file
 * is split into lines nor the body re-joined: the body is one slice.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  if (nl === -1) nl = text.length;
  if (text.slice(0, nl) !== '---') return { error: 'no front matter' };
  // The front-matter lines, each with its 0-based line index (the opening
  // '---' is line 0); the closing '---' ends the scan.
  let pos = nl + 1;
  let lineNo = 1;
  let closeEnd = -1;
  const fmLines = [];
  while (pos <= text.length) {
    let e = text.indexOf('\n', pos);
    if (e === -1) e = text.length;
    if (text.slice(pos, e) === '---') { closeEnd = e; break; }
    fmLines.push([lineNo, text.slice(pos, e)]);
    pos = e + 1;
    lineNo++;
    if (e === text.length) break;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (const [i, line] of fmLines) {
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
    raw = raw.slice(0, end);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

/** A fence-opening line's language, or null when the line is not one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  let i = hashes;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return null;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return { depth: hashes, text: line.slice(i, end) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text after `- ` or `* `, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text after `N. ` (1-9 digits), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !HAS_WS.test(line[i]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Lexing and rendering run in one pass over the lines, so no block tokens
 * are ever built: each block is rendered as it is recognised.
 */
function renderMarkdown(src, env, slugify) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let inner = '';
      i++;
      while (i < n && !fenceClose(lines[i])) inner += `${escapeHtml(lines[i++])}\n`;
      i++;
      html += `<pre><code${cls}>${inner}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const h = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
      i++;
      continue;
    }
    if (isHr(line)) { html += '<hr>\n'; i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const cleaned = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') cleaned.push(t);
      }
      html += cleaned.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(cleaned.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(l);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      let inner = '';
      for (const item of items) inner += `<li>${inline(item.join('\n'), env)}</li>\n`;
      html += `${open}\n${inner}</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const h = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

/** Whether a character code is one a backslash escapes. */
const ESCAPABLE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One native
 * regular-expression scan finds the next character that matters (a markup
 * opener or a character that needs escaping); the plain text between two
 * such characters is copied as-is, so no character is ever visited twice
 * and no run is escaped more than once.
 */
function inline(s, env) {
  const scan = INLINE_SCAN;
  scan.lastIndex = 0;
  let out = '';
  let i = 0;
  let m;
  while ((m = scan.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (c === '&') { out += s.slice(i, j); out += '&amp;'; i = j + 1; continue; }
    if (c === '<') { out += s.slice(i, j); out += '&lt;'; i = j + 1; continue; }
    if (c === '>') { out += s.slice(i, j); out += '&gt;'; i = j + 1; continue; }
    if (c === '"') { out += s.slice(i, j); out += '&quot;'; i = j + 1; continue; }
    if (c === "'") { out += s.slice(i, j); out += '&#39;'; i = j + 1; continue; }
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) {
        out += s.slice(i, j);
        // The escaped character is itself escaped for HTML: of the
        // escapable characters only `>` needs it (`&gt;`).
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        i = j + 2;
        scan.lastIndex = i;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += s.slice(i, j);
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
        scan.lastIndex = i;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += s.slice(i, j);
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
          scan.lastIndex = i;
        } else {
          // A failed `**` is itself, both stars, and the second star is
          // never re-examined as an opener: skip past it too.
          scan.lastIndex = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += s.slice(i, j);
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
          scan.lastIndex = i;
        }
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !HAS_WS.test(target)) {
      out += s.slice(i, j);
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = m2 + 1;
      scan.lastIndex = i;
    }
  }
  out += s.slice(i);
  return out;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function onlySpaces(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed templates (`templates`, a Map of name to
 * nodes, a template that did not parse absent), the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- compiled templates

/**
 * Compile a parsed template's node tree into a function fn(R, sc, dp) that
 * renders it: R carries the shared helpers (lookup, textOf, truthy, the
 * HTML escape, the map of compiled templates) and sc is the scope chain.
 * The generated code is a straight transliteration of the tree — the same
 * lookups, the same truth test, the same loop bindings (the loop variable
 * is bound through a computed key, exactly as the interpreter binds it) —
 * so it renders byte for byte what the interpreter renders, without the
 * per-node dispatch. Every literal is carried through JSON.stringify, so
 * no template text can break out of the generated code.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const gen = (ns, sc) => {
    let code = '';
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          code += `out+=${JSON.stringify(n.text)};`;
          break;
        case 'var':
          code += `out+=R.esc(R.tx(R.lk(${sc},${JSON.stringify(n.path)})));`;
          break;
        case 'raw':
          code += `out+=R.tx(R.lk(${sc},${JSON.stringify(n.path)}));`;
          break;
        case 'if':
          code += `if(R.tr(R.lk(${sc},${JSON.stringify(n.path)}))!==${n.not}){${gen(n.then, sc)}}`;
          if (n.else !== null) code += `else{${gen(n.else, sc)}}`;
          break;
        case 'for': {
          const u = uid++;
          code += `var _x${u}=R.lk(${sc},${JSON.stringify(n.path)});`;
          // One scope object and one loop object per loop, reused across
          // iterations (their fields are rewritten each time): rendering
          // is synchronous and nothing keeps a scope past its iteration,
          // so no iteration can observe the previous one's bindings.
          code += `var _s${u}={vars:{[${JSON.stringify(n.name)}]:undefined,loop:{index:0,first:false,last:false,length:0}},parent:${sc}};`;
          code += `if(Array.isArray(_x${u})){for(var _k${u}=0;_k${u}<_x${u}.length;_k${u}++){`;
          code += `_s${u}.vars[${JSON.stringify(n.name)}]=_x${u}[_k${u}];_s${u}.vars.loop.index=_k${u}+1;_s${u}.vars.loop.first=_k${u}===0;_s${u}.vars.loop.last=_k${u}===_x${u}.length-1;_s${u}.vars.loop.length=_x${u}.length;`;
          code += gen(n.body, `_s${u}`);
          code += '}}';
          break;
        }
        case 'include': {
          const u = uid++;
          code += `var _f${u}=R.TPL[${JSON.stringify(n.name)}];if(_f${u}!==undefined&&dp<8){out+=_f${u}(R,${sc},dp+1);}`;
          break;
        }
      }
    }
    return code;
  };
  return new Function('R', 'sc', 'dp', `var out="";${gen(nodes, 'sc')}return out;`);
}

/**
 * Compile every parsed template, or null when any of them does not compile:
 * then the whole case falls back to the tree interpreter, so an include of
 * a template renders exactly as it would there.
 */
function compileTemplates(templates) {
  const compiled = new Map();
  const TPL = Object.create(null);
  try {
    for (const [name, nodes] of templates) {
      const fn = compileTemplate(nodes);
      compiled.set(name, fn);
      TPL[name] = fn;
    }
  } catch {
    return null;
  }
  return { compiled, TPL };
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
function build(input) {
  const slugify = makeSlugify();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const pathCache = new Map();
  const hasScheme = (target) => {
    const c = target.indexOf(':');
    if (c <= 0) return false;
    const f = target.charCodeAt(0);
    if (!((f >= 65 && f <= 90) || (f >= 97 && f <= 122))) return false;
    for (let i = 1; i < c; i++) {
      const ch = target.charCodeAt(i);
      if (!((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 43 || ch === 45 || ch === 46)) return false;
    }
    return true;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path;
        if (rel === '') path = null;
        else {
          const key = `${dir}\n${rel}`;
          if (pathCache.has(key)) path = pathCache.get(key);
          else {
            path = resolvePath(dir, rel);
            pathCache.set(key, path);
          }
        }
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        const t = bySlug.get(slug);
        return t !== undefined ? t : { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  /** A post's card, as lists show it. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const compiledSet = compileTemplates(templates);
  const R = compiledSet === null ? null : { lk: lookup, tx: textOf, tr: truthy, esc: escapeHtml, TPL: compiledSet.TPL };
  const render = (name, vars) => {
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    if (R !== null) {
      const fn = compiledSet.compiled.get(name);
      if (fn !== undefined) return fn(R, scope, 0);
    }
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, scope, ctx, 0);
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
