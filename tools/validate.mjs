// Local re-check of the gate's seven rows, against an output directory main.ts wrote.
// This is a re-implementation for development only: the sealed scorer on the server is the
// authority. Usage: node tools/validate.mjs [out-dir] [--snapshot path]
//
// Row by row, it checks what the gate checks: the dashboard's files and their no-network
// rule, the board's rows and slugs, the ranks and implied values, the watchlist coverage,
// the farm steps, the screenshots, and the dossier byte for byte. It also checks the two
// things the judge needs beyond the gate: the dashboard's source fits the 65,536-byte text
// the dossier shows whole, and no file was cut from it.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const outDir = process.argv[2] ?? join(root, 'out');
const snapPath = process.argv.find((a) => a.startsWith('--snapshot='))?.slice('--snapshot='.length)
  ?? '/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json';

const failures = [];
const notes = [];
function fail(row, detail) { failures.push(`${row}: ${detail}`); console.log(`FAIL ${row}: ${detail}`); }
function pass(row, detail) { console.log(`ok   ${row}: ${detail}`); }

const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
const slugs = new Set(snapshot.protocols.map((p) => p.slug));
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// --- 1. dashboard_files -------------------------------------------------------
const dashDir = join(outDir, 'dashboard');
let dashFiles = [];
(function walk(dir, rel) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) { fail('dashboard_files', `dashboard/${p} is a dot-directory`); return; }
      walk(join(dir, e.name), p);
    } else if (e.isFile()) {
      dashFiles.push(p);
    }
  }
})(dashDir, '');
dashFiles.sort();
const dashBytes = dashFiles.reduce((n, f) => n + statSync(join(dashDir, f)).size, 0);
const hasHtml = dashFiles.includes('index.html');
const hasCss = dashFiles.some((f) => f.endsWith('.css'));
const hasJs = dashFiles.some((f) => f.endsWith('.js'));
if (!hasHtml || !hasCss || !hasJs) fail('dashboard_files', `index.html=${hasHtml} css=${hasCss} js=${hasJs}`);
else if (dashFiles.length > 400) fail('dashboard_files', `${dashFiles.length} files, over 400`);
else if (dashBytes > 4_194_304) fail('dashboard_files', `${dashBytes} bytes, over 4 MiB`);
else {
  let bad = null;
  for (const f of dashFiles) {
    const base = f.split('/').pop();
    if (!PLAIN.test(base)) { bad = `${f}: a name is letters, digits and . _ -`; break; }
    const text = readFileSync(join(dashDir, f), 'utf8');
    if (f.endsWith('.html')) {
      const m = text.match(/(?:src|href)\s*=\s*["'][^"']*https?:\/\//i) ?? text.match(/<style[^>]*>[\s\S]*?https?:\/\//i) ?? text.match(/<script[^>]*\bsrc\s*=\s*["']https?:\/\//i);
      if (m) { bad = `${f}: an HTML attribute or style names a network address`; break; }
    } else if (f.endsWith('.css')) {
      if (/https?:\/\//.test(text)) { bad = `${f}: a CSS file names a network address`; break; }
    } else if (f.endsWith('.js') || f.endsWith('.mjs')) {
      if (/(?:import\s+[^;]*?from\s*|export\s+[^;]*?from\s*|require\s*\(\s*|import\s*\()\s*["']https?:\/\//.test(text)) {
        bad = `${f}: a JavaScript import names a network address`; break;
      }
    }
  }
  if (bad) fail('dashboard_files', bad);
  else pass('dashboard_files', `${dashFiles.length} files, ${dashBytes} bytes, index.html + css + js, no network address`);
}
if (dashBytes > 65_536) notes.push(`dashboard source is ${dashBytes} bytes: the dossier's text cap is 65,536, so the judge would read a cut source`);
else notes.push(`dashboard source is ${dashBytes} bytes: fits the 65,536-byte dossier text whole`);

// --- 2. board_file ------------------------------------------------------------
const boardPath = join(outDir, 'board.json');
const boardStat = statSync(boardPath);
const board = JSON.parse(readFileSync(boardPath, 'utf8'));
const rows = Array.isArray(board) ? board : board.rows;
if (!Array.isArray(rows)) fail('board_file', 'rows is not an array');
else if (rows.length < 100 || rows.length > 4000) fail('board_file', `${rows.length} rows, outside 100..4000`);
else if (boardStat.size > 8_388_608) fail('board_file', `${boardStat.size} bytes, over 8 MiB`);
else {
  let bad = null;
  const seen = new Set();
  for (const r of rows) {
    if (typeof r.slug !== 'string' || !slugs.has(r.slug)) { bad = `slug ${JSON.stringify(r.slug)} is not in the snapshot`; break; }
    if (seen.has(r.slug)) { bad = `slug ${r.slug} appears twice`; break; }
    seen.add(r.slug);
    if (typeof r.name !== 'string' || r.name.length === 0) { bad = `${r.slug} has an empty name`; break; }
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) { bad = `${r.slug} has rank ${r.rank}`; break; }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) { bad = `${r.slug} has implied value ${r.implied_value_usd}`; break; }
    if (!Array.isArray(r.farm_steps)) { bad = `${r.slug} has no farm_steps array`; break; }
  }
  if (bad) fail('board_file', bad);
  else pass('board_file', `${rows.length} rows, ${boardStat.size} bytes, every slug in the snapshot`);
}

// --- 3. sorted_by_value -------------------------------------------------------
if (Array.isArray(rows)) {
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  let bad = null;
  for (let i = 0; i < byRank.length; i++) if (byRank[i].rank !== i + 1) { bad = `rank ${i + 1} is ${byRank[i].rank}`; break; }
  if (!bad) for (let i = 1; i < byRank.length; i++) {
    if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) { bad = `rank ${i + 1} outranks rank ${i} on implied value`; break; }
  }
  if (!bad && rows.length >= 2 && byRank[0].implied_value_usd === byRank[byRank.length - 1].implied_value_usd) {
    bad = 'all rows share the same implied value';
  }
  if (bad) fail('sorted_by_value', bad);
  else pass('sorted_by_value', `ranks 1..${rows.length}, implied value ${byRank[0].implied_value_usd} down to ${byRank[byRank.length - 1].implied_value_usd}`);
}

// --- 4. coverage --------------------------------------------------------------
if (Array.isArray(rows)) {
  const have = new Set(rows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !have.has(s));
  if (missing.length > 0) fail('coverage', `missing ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`);
  else {
    const outside = rows.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
    pass('coverage', `${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist slugs, ${outside} rows outside it`);
  }
}

// --- 5. farm_steps ------------------------------------------------------------
if (Array.isArray(rows)) {
  let bad = null;
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) { bad = `${r.slug} has ${r.farm_steps.length} farm steps`; break; }
    for (const s of r.farm_steps) {
      if (typeof s !== 'string' || s.trim().length < 20 || s.trim().length > 600) { bad = `${r.slug} has a farm step of ${s.trim().length} characters`; break; }
    }
    if (bad) break;
  }
  if (bad) fail('farm_steps', bad);
  else pass('farm_steps', `every row has ${rows[0].farm_steps.length} steps of 20..600 characters`);
}

// --- 6. screenshots -----------------------------------------------------------
function pngDims(b) {
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), whole: b.subarray(b.length - 12).toString('ascii').includes('IEND') };
}
function jpegDims(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    const len = b.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: b.readUInt16BE(at + 7), h: b.readUInt16BE(at + 5), whole: b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 };
    }
    at += 2 + len;
  }
  return null;
}
const shotsDir = join(outDir, 'screenshots');
const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((n) => !n.startsWith('.')).sort() : [];
if (shots.length < 3 || shots.length > 4) fail('screenshots', `${shots.length} images, need 3 or 4`);
else {
  let bad = null;
  for (const name of shots) {
    const b = readFileSync(join(shotsDir, name));
    if (b.length > 524_288) { bad = `${name} is ${b.length} bytes, over 512 KiB`; break; }
    const dims = pngDims(b) ?? jpegDims(b);
    if (!dims) { bad = `${name} is neither a whole PNG nor a JPEG`; break; }
    if (!dims.whole) { bad = `${name} is truncated`; break; }
    const long = Math.max(dims.w, dims.h);
    const short = Math.min(dims.w, dims.h);
    if (long > 1440 || short < 800) { bad = `${name} is ${dims.w}x${dims.h}: long side over 1440 or short side under 800`; break; }
  }
  if (bad) fail('screenshots', bad);
  else pass('screenshots', shots.map((n) => `${n} (${statSync(join(shotsDir, n)).size} bytes)`).join(', '));
}

// --- 7. dossier_matches -------------------------------------------------------
const dossierPath = join(outDir, 'dossier.json');
const dossierStat = statSync(dossierPath);
let rebuilt;
try {
  rebuilt = buildDossier(outDir, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
} catch (err) {
  fail('dossier_matches', `buildDossier refuses: ${err.message}`);
}
if (rebuilt) {
  const actual = readFileSync(dossierPath);
  if (dossierStat.size > 1_572_864) fail('dossier_matches', `dossier.json is ${dossierStat.size} bytes, over 1.5 MiB`);
  else if (!Buffer.from(rebuilt).equals(actual)) fail('dossier_matches', 'dossier.json is not byte for byte what buildDossier writes');
  else {
    const doc = JSON.parse(actual.toString('utf8'));
    const cut = doc.text.includes('[Cut at');
    if (cut) notes.push('dossier text is cut at 65,536 bytes: the judge reads a partial source');
    pass('dossier_matches', `dossier.json is ${dossierStat.size} bytes, byte-identical to buildDossier${cut ? ' (text cut)' : ', text whole'}`);
  }
}

for (const n of notes) console.log(`note ${n}`);
if (failures.length > 0) {
  console.log(`\n${failures.length} gate row(s) failed`);
  process.exit(1);
}
console.log('\nall 7 gate rows pass locally');
