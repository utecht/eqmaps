// The World Web: an atlas view that draws each zone's actual map geometry as
// an engraved card on dark leather, placed so that connected zones sit off
// the doors that join them. Norrath's geography is not topographically sound,
// so a collision pass separates overlapping maps and brass strands stretch
// between the actual door positions.
//
// Layout needs no map fetches — zone bounds and door coordinates live in
// zones.json. Geometry streams in per zone and is etched once onto a cached
// offscreen canvas.

import { Camera } from './camera.js';
import { parseMapText } from './parser.js';

const PARCH = '#e9dcc3';
const MAX_NODES = 110;
const GAP = 26; // atlas-space gap between joined door anchors
const THUMB_MAX = 512; // offscreen thumbnail resolution cap

export class GraphView {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.camera = new Camera();
    this.nodes = [];
    this.edges = [];
    this.center = null;
    this.depth = 2;
    this.hovered = null;
    this.truncated = 0;
    this.onOpen = null;
    this.onExit = null;
    this.thumbs = new Map(); // short -> {canvas} | 'loading' | 'failed'
    this._raf = 0;

    this.camera.attach(canvas, {
      onChange: () => this.requestRender(),
      onHover: (sx, sy) => this._hover(sx, sy),
      onClick: (sx, sy) => this._click(sx, sy),
      onContext: () => this.onExit && this.onExit(),
    });

    const ro = new ResizeObserver(() => this._resize());
    ro.observe(canvas);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.requestRender();
  }

  setWorld(adjacency, names, hubs = new Set(), zonesMeta = {}) {
    this.adjacency = adjacency;
    this.names = names;
    this.hubs = hubs;
    this.zonesMeta = zonesMeta;
    this.hideHubRoutes = true;
  }

  // Display size compresses true zone extents (sqrt) so dungeons stay legible
  // beside the plains zones.
  _makeNode(id, depth) {
    const meta = this.zonesMeta[id];
    const [minX, minY, maxX, maxY] = meta.bounds;
    const bw = Math.max(maxX - minX, 60);
    const bh = Math.max(maxY - minY, 60);
    const extent = Math.max(bw, bh);
    const size = Math.min(330, Math.max(84, Math.sqrt(extent) * 3.4));
    const scale = size / extent;
    return {
      id,
      name: this.names.get(id) || id,
      depth,
      x: 0,
      y: 0,
      scale,
      w: bw * scale,
      h: bh * scale,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      deg: 0,
    };
  }

  // Atlas-space position of the first door in `node` that leads to targetId.
  _doorPos(node, targetId) {
    const link = (this.zonesMeta[node.id].links || []).find((l) => l.t === targetId);
    if (!link) return null;
    return [node.x + (link.x - node.cx) * node.scale, node.y + (link.y - node.cy) * node.scale];
  }

  build(center, depth = this.depth) {
    this.center = center;
    this.depth = depth;

    // BFS neighborhood. With hub routes hidden, planar hubs may appear but
    // are never traversed *through* — except as the center.
    const blocked = (id) => this.hideHubRoutes && id !== center && this.hubs.has(id);
    const depthOf = new Map([[center, 0]]);
    const parentOf = new Map();
    const order = [center];
    for (let i = 0; i < order.length; i++) {
      const cur = order[i];
      const d = depthOf.get(cur);
      if (d >= depth || blocked(cur)) continue;
      for (const nb of this.adjacency.get(cur) || []) {
        if (!depthOf.has(nb) && this.zonesMeta[nb]) {
          depthOf.set(nb, d + 1);
          parentOf.set(nb, cur);
          order.push(nb);
        }
      }
    }
    this.truncated = Math.max(0, order.length - MAX_NODES);
    const included = order.slice(0, MAX_NODES);
    const idx = new Map(included.map((id, i) => [id, i]));

    this.nodes = included.map((id) => this._makeNode(id, depthOf.get(id)));
    const byId = new Map(this.nodes.map((n) => [n.id, n]));

    // Seed positions: hang each zone off the door that leads to it, aligning
    // the reciprocal door when the maps agree on where they meet.
    for (const id of included) {
      if (id === center) continue;
      const node = byId.get(id);
      const parent = byId.get(parentOf.get(id));
      if (!parent) continue;
      const door = this._doorPos(parent, id);
      const [ax, ay] = door || [parent.x, parent.y];
      let dx = ax - parent.x;
      let dy = ay - parent.y;
      const dl = Math.hypot(dx, dy);
      if (dl < 1) {
        const a = (idx.get(id) * 2.399) % (Math.PI * 2); // deterministic spread
        dx = Math.cos(a);
        dy = Math.sin(a);
      } else {
        dx /= dl;
        dy /= dl;
      }
      const backLink = (this.zonesMeta[id].links || []).find((l) => l.t === parent.id);
      if (backLink) {
        node.x = ax + dx * GAP - (backLink.x - node.cx) * node.scale;
        node.y = ay + dy * GAP - (backLink.y - node.cy) * node.scale;
      } else {
        node.x = ax + dx * (GAP + Math.max(node.w, node.h) / 2);
        node.y = ay + dy * (GAP + Math.max(node.w, node.h) / 2);
      }
    }

    // Edges among included nodes; non-center hubs keep only their discovery
    // edge so they don't become 50-spoke portal stars.
    this.edges = [];
    for (const [a, i] of idx) {
      for (const b of this.adjacency.get(a) || []) {
        const j = idx.get(b);
        if (j === undefined || i >= j) continue;
        if (blocked(a) && parentOf.get(a) !== b) continue;
        if (blocked(b) && parentOf.get(b) !== a) continue;
        this.edges.push([i, j]);
      }
    }
    for (const [i, j] of this.edges) {
      this.nodes[i].deg++;
      this.nodes[j].deg++;
    }

    this._relax(220);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    this.camera.fit(
      [minX, minY - 20, maxX, maxY + 30],
      this.canvas.clientWidth || 800,
      this.canvas.clientHeight || 600,
      0.03
    );
    this.hovered = null;

    for (const n of this.nodes) this._ensureThumb(n.id);
    this.requestRender();
  }

  // Door-spring + card-collision relaxation. The center map stays pinned.
  // Springs fade out toward the end so the final iterations are pure
  // separation — overlap-free beats door-perfect in a world that isn't
  // topographically sound anyway.
  _relax(iterations) {
    const n = this.nodes;
    const PAD_X = 46;
    const PAD_Y = 62; // extra clearance below cards for the name plates
    for (let it = 0; it < iterations; it++) {
      const t = 1 - it / iterations;
      const springPhase = it < iterations * 0.65;

      if (springPhase) {
        for (const [i, j] of this.edges) {
          const a = n[i], b = n[j];
          const pa = this._doorPos(a, b.id) || [a.x, a.y];
          const pb = this._doorPos(b, a.id) || [b.x, b.y];
          let dx = pb[0] - pa[0];
          let dy = pb[1] - pa[1];
          const d = Math.hypot(dx, dy) || 1;
          const f = (d - GAP) * 0.055 * t;
          dx = (dx / d) * f;
          dy = (dy / d) * f;
          if (a.depth !== 0) { a.x += dx; a.y += dy; }
          if (b.depth !== 0) { b.x -= dx; b.y -= dy; }
        }
      }

      this._collidePass(springPhase ? 0.45 : 0.85, PAD_X, PAD_Y);
    }
    // Final guarantee: sweep at full strength until nothing overlaps.
    for (let sweep = 0; sweep < 160; sweep++) {
      if (!this._collidePass(1, PAD_X, PAD_Y)) break;
    }
  }

  _collidePass(push, padX, padY) {
    const n = this.nodes;
    let moved = false;
    for (let i = 0; i < n.length; i++) {
      for (let j = i + 1; j < n.length; j++) {
        const a = n[i], b = n[j];
        const ox = (a.w + b.w) / 2 + padX - Math.abs(b.x - a.x);
        const oy = (a.h + b.h) / 2 + padY - Math.abs(b.y - a.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // push apart along the axis of least penetration
        let fx = 0, fy = 0;
        if (ox < oy) fx = (b.x > a.x ? 1 : -1) * ox * 0.5 * push;
        else fy = (b.y > a.y ? 1 : -1) * oy * 0.5 * push;
        const aPinned = a.depth === 0;
        const bPinned = b.depth === 0;
        if (!aPinned) { a.x -= fx * (bPinned ? 2 : 1); a.y -= fy * (bPinned ? 2 : 1); }
        if (!bPinned) { b.x += fx * (aPinned ? 2 : 1); b.y += fy * (aPinned ? 2 : 1); }
      }
    }
    return moved;
  }

  // ---- thumbnails: one-time etching of the base layer to an offscreen canvas ----

  async _ensureThumb(id) {
    if (this.thumbs.has(id)) return;
    this.thumbs.set(id, 'loading');
    try {
      const meta = this.zonesMeta[id];
      const base = (meta.layers || []).find((l) => l[0] === 0) || meta.layers[0];
      const res = await fetch(`maps/${encodeURIComponent(base[1])}`);
      if (!res.ok) throw new Error(res.status);
      const parsed = parseMapText(await res.text());
      const [minX, minY, maxX, maxY] = meta.bounds;
      const bw = Math.max(maxX - minX, 1);
      const bh = Math.max(maxY - minY, 1);
      const s = Math.min(THUMB_MAX / Math.max(bw, bh), 1);
      const c = document.createElement('canvas');
      c.width = Math.max(24, Math.ceil(bw * s));
      c.height = Math.max(24, Math.ceil(bh * s));
      const ctx = c.getContext('2d');
      ctx.setTransform(s, 0, 0, s, -minX * s, -minY * s);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(236,223,192,0.8)';
      ctx.lineWidth = 1.1 / s;
      const path = new Path2D();
      for (const b of parsed.batches) {
        const segs = b.segs;
        for (let i = 0; i < segs.length; i += 6) {
          path.moveTo(segs[i], segs[i + 1]);
          path.lineTo(segs[i + 3], segs[i + 4]);
        }
      }
      ctx.stroke(path);
      // LRU-ish cap on cached etchings
      if (this.thumbs.size > 130) {
        for (const k of this.thumbs.keys()) {
          if (this.thumbs.size <= 100) break;
          if (this.thumbs.get(k) !== 'loading') this.thumbs.delete(k);
        }
      }
      this.thumbs.set(id, { canvas: c });
    } catch {
      this.thumbs.set(id, 'failed');
    }
    this.requestRender();
  }

  // ---- interaction ----

  _nodeAt(sx, sy) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const [x, y] = this.camera.toScreen(n.x, n.y);
      const hw = (n.w / 2) * this.camera.k + 6;
      const hh = (n.h / 2) * this.camera.k + 6;
      if (Math.abs(sx - x) < hw && Math.abs(sy - y) < hh) return i;
    }
    return null;
  }

  _hover(sx, sy) {
    const i = this._nodeAt(sx, sy);
    if (i !== this.hovered) {
      this.hovered = i;
      this.canvas.style.cursor = i !== null ? 'pointer' : 'grab';
      if (i !== null) {
        const node = this.nodes[i];
        const [x, y] = this.camera.toScreen(node.x, node.y);
        const hub = this.hubs.has(node.id) ? 'planar hub · ' : '';
        this.tooltip.innerHTML = `Open the map of <b>${node.name}</b><small>${hub}${node.deg} passage${node.deg === 1 ? '' : 's'} · ${node.depth} hop${node.depth === 1 ? '' : 's'} away</small>`;
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top = `${y - (node.h / 2) * this.camera.k - 8}px`;
        this.tooltip.hidden = false;
      } else {
        this.tooltip.hidden = true;
      }
      this.requestRender();
    }
  }

  _click(sx, sy) {
    const i = this._nodeAt(sx, sy);
    if (i !== null && this.onOpen) {
      this.tooltip.hidden = true;
      this.onOpen(this.nodes[i].id);
    }
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  // ---- render ----

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cam = this.camera;
    if (!w || !h) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createRadialGradient(w / 2, h / 2, 60, w / 2, h / 2, Math.max(w, h) * 0.8);
    bg.addColorStop(0, '#221a10');
    bg.addColorStop(1, '#100b06');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const x = ((i * 127.3 + 41.7) % 611) / 611 * w;
      const y = ((i * 83.9 + 17.3) % 431) / 431 * h;
      const a = 0.05 + ((i * 37) % 10) / 10 * 0.1;
      ctx.fillStyle = `rgba(233,220,195,${a})`;
      ctx.fillRect(x, y, 1.3, 1.3);
    }

    if (!this.nodes.length) return;

    const hotSet = new Set();
    if (this.hovered !== null) {
      hotSet.add(this.hovered);
      for (const [i, j] of this.edges) {
        if (i === this.hovered) hotSet.add(j);
        if (j === this.hovered) hotSet.add(i);
      }
    }

    // --- passage strands between actual door positions ---
    for (const [i, j] of this.edges) {
      const a = this.nodes[i];
      const b = this.nodes[j];
      const pa = this._doorPos(a, b.id) || [a.x, a.y];
      const pb = this._doorPos(b, a.id) || [b.x, b.y];
      const [x1, y1] = cam.toScreen(pa[0], pa[1]);
      const [x2, y2] = cam.toScreen(pb[0], pb[1]);
      const hot = this.hovered !== null && (i === this.hovered || j === this.hovered);
      const mx = (x1 + x2) / 2 + (y2 - y1) * 0.1;
      const my = (y1 + y2) / 2 - (x2 - x1) * 0.1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx, my, x2, y2);
      ctx.strokeStyle = hot ? 'rgba(238,194,114,0.9)' : 'rgba(201,151,59,0.42)';
      ctx.lineWidth = hot ? 2 : 1.2;
      ctx.stroke();
      // small door studs at each end
      for (const [px, py] of [[x1, y1], [x2, y2]]) {
        ctx.beginPath();
        ctx.arc(px, py, hot ? 3 : 2.2, 0, Math.PI * 2);
        ctx.fillStyle = hot ? '#eec272' : 'rgba(201,151,59,0.55)';
        ctx.fill();
      }
    }

    // --- zone cards, farthest rings first so nearer maps sit on top ---
    const drawOrder = [...this.nodes.keys()].sort(
      (i, j) => this.nodes[j].depth - this.nodes[i].depth
    );
    for (const i of drawOrder) {
      const node = this.nodes[i];
      const [x, y] = cam.toScreen(node.x, node.y);
      const cw = node.w * cam.k;
      const ch = node.h * cam.k;
      if (x + cw / 2 < -40 || y + ch / 2 < -40 || x - cw / 2 > w + 40 || y - ch / 2 > h + 40) continue;
      const isCenter = node.depth === 0;
      const isHub = !isCenter && this.hubs.has(node.id);
      const hot = i === this.hovered || hotSet.has(i);

      // card
      ctx.beginPath();
      ctx.roundRect(x - cw / 2 - 5, y - ch / 2 - 5, cw + 10, ch + 10, 4);
      ctx.fillStyle = isCenter ? 'rgba(46,34,17,0.92)' : isHub ? 'rgba(26,36,48,0.88)' : 'rgba(26,19,11,0.88)';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.strokeStyle = isCenter
        ? '#e2b466'
        : isHub
          ? hot ? '#b4d4f2' : 'rgba(126,166,206,0.6)'
          : hot
            ? 'rgba(238,194,114,0.95)'
            : 'rgba(201,151,59,0.32)';
      ctx.lineWidth = isCenter ? 1.8 : 1;
      ctx.stroke();

      // etched map
      const thumb = this.thumbs.get(node.id);
      if (thumb && thumb.canvas) {
        ctx.globalAlpha = isCenter || hot ? 1 : 0.85;
        ctx.drawImage(thumb.canvas, x - cw / 2, y - ch / 2, cw, ch);
        ctx.globalAlpha = 1;
      }

      // name plate
      const fs = isCenter ? 13 : 11;
      ctx.font = isCenter ? `700 ${fs}px "Cinzel", serif` : `500 ${fs}px "Alegreya Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = node.name;
      const tw = ctx.measureText(label).width;
      const ly = y + ch / 2 + 13;
      ctx.fillStyle = 'rgba(16,11,6,0.82)';
      ctx.beginPath();
      ctx.roundRect(x - tw / 2 - 7, ly - fs / 2 - 4, tw + 14, fs + 8, 3);
      ctx.fill();
      ctx.fillStyle = isCenter ? '#eec272' : isHub ? '#c4d8ea' : hot ? '#f4e2b8' : PARCH;
      ctx.fillText(label, x, ly + 0.5);
    }

    if (this.truncated > 0) {
      ctx.font = '500 11px "Alegreya Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(233,220,195,0.5)';
      ctx.fillText(`showing the nearest ${MAX_NODES} zones — ${this.truncated} more beyond`, 16, h - 14);
    }
  }
}
