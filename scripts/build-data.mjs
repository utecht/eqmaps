// Scans the Brewall map pack, resolves "to_..." point labels into a zone
// connection graph, and writes data/zones.json for the frontend.
//
//   node scripts/build-data.mjs
//
// Also writes data/report.json with unresolved labels so the alias table in
// zone-names.mjs can be improved over time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONE_NAMES, ALIASES } from './zone-names.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAPS = path.join(ROOT, 'maps');
const OUT = path.join(ROOT, 'data', 'zones.json');
const REPORT = path.join(ROOT, 'data', 'report.json');

// Normalize a zone name or label for matching: drop parentheticals, treat
// punctuation as spaces, drop a leading "the", then strip to alphanumerics.
function norm(s) {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[_`'’\-.:]/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

function prettify(short) {
  return short.charAt(0).toUpperCase() + short.slice(1);
}

// ---- Scan map directory, group files into zones + layers ----
const files = fs.readdirSync(MAPS).filter((f) => f.toLowerCase().endsWith('.txt'));
const zones = new Map(); // short -> { layers: Map<layerNum, filename> }

for (const f of files) {
  let base = f.slice(0, -4);
  // "nektulos_1_original.txt" is layer 1 of the "nektulos_original" zone
  let original = false;
  const om = base.match(/^(.*)_original$/i);
  if (om) {
    original = true;
    base = om[1];
  }
  const m = base.match(/^(.*)_([1-3])$/);
  let short = (m ? m[1] : base).toLowerCase();
  const layer = m ? Number(m[2]) : 0;
  if (original) short += '_original';
  if (!zones.has(short)) zones.set(short, { layers: new Map() });
  zones.get(short).layers.set(layer, f);
}

// ---- Build the name-matching index ----
const byNorm = new Map(); // normalized name -> [shortnames]
function indexName(key, short) {
  if (!key) return;
  if (!byNorm.has(key)) byNorm.set(key, []);
  if (!byNorm.get(key).includes(short)) byNorm.get(key).push(short);
}
for (const short of zones.keys()) {
  const name = ZONE_NAMES[short] || prettify(short);
  indexName(norm(name), short);
  indexName(norm(short), short);
}

// Prefer classic zones over revamps: display names carrying a parenthetical
// ("(Revamp)", "(ToV)", ...) lose; then shorter shortnames win.
function pickBest(cands) {
  const scored = [...cands].sort((a, b) => {
    const pa = (ZONE_NAMES[a] || '').includes('(') ? 1 : 0;
    const pb = (ZONE_NAMES[b] || '').includes('(') ? 1 : 0;
    if (pa !== pb) return pa - pb;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : 1;
  });
  return scored[0];
}

function resolveLabel(label) {
  const stripped = label.replace(/^to[_\s]+/i, '');
  const n = norm(stripped);
  if (!n) return null;
  if (ALIASES[n] && zones.has(ALIASES[n])) return ALIASES[n];
  const cands = byNorm.get(n);
  if (cands && cands.length) return pickBest(cands);
  return null;
}

// ---- Parse every file: bounds + "to_" point labels ----
function parseFile(fp) {
  const text = fs.readFileSync(fp, 'latin1');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let lineCount = 0;
  const toPoints = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const kind = line[0].toUpperCase();
    if (kind !== 'L' && kind !== 'P') continue;
    const parts = line.slice(1).split(',');
    if (kind === 'L') {
      if (parts.length < 6) continue;
      const x1 = +parts[0], y1 = +parts[1], x2 = +parts[3], y2 = +parts[4];
      if ([x1, y1, x2, y2].some(Number.isNaN)) continue;
      lineCount++;
      if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
      if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
      if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
      if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
    } else {
      if (parts.length < 8) continue;
      const x = +parts[0], y = +parts[1], z = +parts[2];
      if ([x, y].some(Number.isNaN)) continue;
      const label = parts.slice(7).join(',').trim();
      if (/^to[_\s]/i.test(label)) toPoints.push({ label, x, y, z });
    }
  }
  return { minX, minY, maxX, maxY, lineCount, toPoints };
}

const out = { generated: 'brewall', zones: {} };
const unresolved = new Map(); // label -> { count, zones: [] }
let totalLabels = 0, resolvedLabels = 0, totalLines = 0;

for (const [short, z] of [...zones.entries()].sort()) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let lineCount = 0;
  const links = [];
  for (const [layer, fname] of [...z.layers.entries()].sort((a, b) => a[0] - b[0])) {
    const p = parseFile(path.join(MAPS, fname));
    lineCount += p.lineCount;
    if (p.minX < minX) minX = p.minX;
    if (p.minY < minY) minY = p.minY;
    if (p.maxX > maxX) maxX = p.maxX;
    if (p.maxY > maxY) maxY = p.maxY;
    for (const tp of p.toPoints) {
      totalLabels++;
      const target = resolveLabel(tp.label);
      const cleaned = tp.label
        .replace(/^to[_\s]+/i, '')
        .replace(/_/g, ' ')
        .trim();
      if (target && target !== short) {
        resolvedLabels++;
        links.push({
          t: target,
          l: cleaned,
          x: Math.round(tp.x * 10) / 10,
          y: Math.round(tp.y * 10) / 10,
          z: Math.round(tp.z * 10) / 10,
        });
      } else if (!target) {
        const u = unresolved.get(tp.label) || { count: 0, zones: [] };
        u.count++;
        if (!u.zones.includes(short)) u.zones.push(short);
        unresolved.set(tp.label, u);
      }
    }
  }
  totalLines += lineCount;
  if (lineCount === 0 && links.length === 0) continue; // empty/placeholder file
  out.zones[short] = {
    name: ZONE_NAMES[short] || prettify(short),
    layers: [...z.layers.entries()].sort((a, b) => a[0] - b[0]), // [layerNum, filename]
    bounds: [minX, minY, maxX, maxY].map((v) => Math.round(v)),
    links,
  };
}

// Wing families: instanced multi-level dungeons ship as sibling zones whose
// names differ only by a wing letter — "Mistmoore Catacombs (A)".."( J)",
// "Plane of Time A/B". The frontend collapses each family to one node in
// the world web so ten wings don't hang off one overworld zone.
const famBase = (name) => {
  const m = name.match(/^(.*?)(?:\s*\(([A-J])\)|\s([A-J]))$/);
  return m ? m[1].trim() : null;
};
const famGroups = new Map();
for (const [s, z] of Object.entries(out.zones)) {
  const b = famBase(z.name);
  if (!b) continue;
  if (!famGroups.has(b)) famGroups.set(b, []);
  famGroups.get(b).push(s);
}
out.families = [];
for (const [b, members] of famGroups) {
  // a zone named exactly the base fronts its family
  const exact = Object.entries(out.zones).find(([, z]) => z.name === b);
  const all = exact ? [exact[0], ...members] : members;
  if (all.length >= 2) out.families.push({ name: b, members: all });
}
out.families.sort((a, b) => (a.name < b.name ? -1 : 1));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wing families: ${out.families.length}`);

const unresolvedSorted = [...unresolved.entries()]
  .map(([label, u]) => ({ label, ...u }))
  .sort((a, b) => b.count - a.count);
fs.writeFileSync(REPORT, JSON.stringify({ unresolved: unresolvedSorted }, null, 2));

console.log(`zones: ${Object.keys(out.zones).length}`);
console.log(`line segments: ${totalLines}`);
console.log(`to_ labels: ${totalLabels}, resolved as links: ${resolvedLabels}`);
console.log(`unresolved unique labels: ${unresolvedSorted.length} (data/report.json)`);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
