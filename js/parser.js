// Parses EverQuest map .txt layers into color-batched line segments and
// labeled points. Map colors were authored for EQ's in-game window, so
// near-white lines/text get remapped to stay legible on our parchment.

function lum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function remapLineColor(r, g, b) {
  const l = lum(r, g, b);
  if (l > 175) {
    const k = 150 / l;
    return [(r * k) | 0, (g * k) | 0, (b * k) | 0];
  }
  return [r, g, b];
}

function remapTextColor(r, g, b) {
  if (lum(r, g, b) > 165) return [84, 66, 40]; // ink brown for near-white text
  return [r, g, b];
}

// Returns { batches, points, minZ, maxZ }
//   batches: [{ css, segs: [x1,y1,z1,x2,y2,z2, ...] }] grouped by color
//   points:  [{ x, y, z, css, size, label, isLink }]
export function parseMapText(text) {
  const batches = new Map();
  const points = [];
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const kind = line[0];
    const parts = line.slice(1).split(',');

    if (kind === 'L' || kind === 'l') {
      if (parts.length < 9) continue;
      const x1 = +parts[0], y1 = +parts[1], z1 = +parts[2];
      const x2 = +parts[3], y2 = +parts[4], z2 = +parts[5];
      if (Number.isNaN(x1) || Number.isNaN(y1) || Number.isNaN(x2) || Number.isNaN(y2)) continue;
      const [r, g, b] = remapLineColor(+parts[6] || 0, +parts[7] || 0, +parts[8] || 0);
      const key = (r << 16) | (g << 8) | b;
      let batch = batches.get(key);
      if (!batch) {
        batch = { css: `rgb(${r},${g},${b})`, segs: [] };
        batches.set(key, batch);
      }
      batch.segs.push(x1, y1, z1, x2, y2, z2);
      if (z1 < minZ) minZ = z1;
      if (z1 > maxZ) maxZ = z1;
      if (z2 < minZ) minZ = z2;
      if (z2 > maxZ) maxZ = z2;
    } else if (kind === 'P' || kind === 'p') {
      if (parts.length < 8) continue;
      const x = +parts[0], y = +parts[1], z = +parts[2];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const [r, g, b] = remapTextColor(+parts[3] || 0, +parts[4] || 0, +parts[5] || 0);
      const label = parts.slice(7).join(',').trim().replace(/_/g, ' ');
      if (!label) continue;
      points.push({
        x, y, z,
        css: `rgb(${r},${g},${b})`,
        size: Math.max(1, Math.min(3, +parts[6] || 2)),
        label,
        isLink: /^to\s/i.test(label),
      });
    }
  }

  return { batches: [...batches.values()], points, minZ, maxZ };
}
