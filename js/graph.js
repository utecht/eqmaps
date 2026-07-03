// The World Web: a force-laid-out chart of zone connections, styled as a
// brass star chart on dark leather — the "zoom out" counterpart to the
// parchment zone map. Click a zone chip to open its map.

import { Camera } from './camera.js';

const BRASS = '#c9973b';
const PARCH = '#e9dcc3';
const MAX_NODES = 110;

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

  setWorld(adjacency, names, hubs = new Set()) {
    this.adjacency = adjacency;
    this.names = names;
    this.hubs = hubs;
    this.hideHubRoutes = true;
  }

  build(center, depth = this.depth) {
    this.center = center;
    this.depth = depth;

    // BFS neighborhood. With hub routes hidden, planar hubs (PoK, Tranquility)
    // may appear but are never traversed *through* — except as the center.
    const blocked = (id) => this.hideHubRoutes && id !== center && this.hubs.has(id);
    const depthOf = new Map([[center, 0]]);
    const parentOf = new Map();
    const order = [center];
    for (let i = 0; i < order.length; i++) {
      const cur = order[i];
      const d = depthOf.get(cur);
      if (d >= depth || blocked(cur)) continue;
      for (const nb of this.adjacency.get(cur) || []) {
        if (!depthOf.has(nb)) {
          depthOf.set(nb, d + 1);
          parentOf.set(nb, cur);
          order.push(nb);
        }
      }
    }
    this.truncated = Math.max(0, order.length - MAX_NODES);
    const included = order.slice(0, MAX_NODES);
    const idx = new Map(included.map((id, i) => [id, i]));

    // Ring-seeded layout, then a short force relaxation.
    const R = 260;
    const perRing = new Map();
    this.nodes = included.map((id) => {
      const d = depthOf.get(id);
      const i = perRing.get(d) || 0;
      perRing.set(d, i + 1);
      return { id, name: this.names.get(id) || id, depth: d, ring: i, x: 0, y: 0, deg: 0 };
    });
    const ringCounts = new Map();
    for (const n of this.nodes) ringCounts.set(n.depth, (ringCounts.get(n.depth) || 0) + 1);
    for (const n of this.nodes) {
      if (n.depth === 0) continue;
      const count = ringCounts.get(n.depth);
      const a = (n.ring / count) * Math.PI * 2 + n.depth * 0.42;
      n.x = Math.cos(a) * R * n.depth;
      n.y = Math.sin(a) * R * n.depth;
    }

    this.edges = [];
    for (const [a, i] of idx) {
      for (const b of this.adjacency.get(a) || []) {
        const j = idx.get(b);
        if (j === undefined || i >= j) continue;
        // With hub routes hidden, a non-center hub keeps only the edge it
        // was discovered through — no 40-spoke portal star.
        if (blocked(a) && parentOf.get(a) !== b) continue;
        if (blocked(b) && parentOf.get(b) !== a) continue;
        this.edges.push([i, j]);
      }
    }
    for (const [i, j] of this.edges) {
      this.nodes[i].deg++;
      this.nodes[j].deg++;
    }

    this._relax(this.depth >= 3 ? 320 : 240, R);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    this.camera.fit(
      [minX - 130, minY - 60, maxX + 130, maxY + 60],
      this.canvas.clientWidth || 800,
      this.canvas.clientHeight || 600,
      0.04
    );
    this.hovered = null;
    this.requestRender();
  }

  _relax(iterations, R) {
    const n = this.nodes;
    for (let it = 0; it < iterations; it++) {
      const t = 1 - it / iterations;
      // pairwise repulsion
      for (let i = 0; i < n.length; i++) {
        for (let j = i + 1; j < n.length; j++) {
          let dx = n[j].x - n[i].x;
          let dy = n[j].y - n[i].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (i - j) * 0.7; dy = 1; d2 = 2; }
          const d = Math.sqrt(d2);
          const f = Math.min(24, 15000 / d2) * t;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          if (n[i].depth !== 0) { n[i].x -= fx; n[i].y -= fy; }
          if (n[j].depth !== 0) { n[j].x += fx; n[j].y += fy; }
        }
      }
      // springs
      for (const [i, j] of this.edges) {
        const dx = n[j].x - n[i].x;
        const dy = n[j].y - n[i].y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - 190) * 0.012 * t;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        if (n[i].depth !== 0) { n[i].x += fx; n[i].y += fy; }
        if (n[j].depth !== 0) { n[j].x -= fx; n[j].y -= fy; }
      }
      // gentle pull toward each node's BFS ring keeps hop-distance readable
      for (const node of n) {
        if (node.depth === 0) continue;
        const d = Math.max(1, Math.hypot(node.x, node.y));
        const target = R * node.depth;
        const f = (target - d) * 0.05 * t;
        node.x += (node.x / d) * f;
        node.y += (node.y / d) * f;
      }
    }
  }

  _chipW(node, ctx) {
    ctx.font = node.depth === 0 ? '700 13px "Cinzel", serif' : '500 11.5px "Alegreya Sans", sans-serif';
    return ctx.measureText(node.name).width + 26;
  }

  _nodeAt(sx, sy) {
    const ctx = this.ctx;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const [x, y] = this.camera.toScreen(node.x, node.y);
      const hw = (this._chipW(node, ctx) * 1) / 2 + 2;
      const hh = node.depth === 0 ? 17 : 13;
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
        this.tooltip.style.top = `${y - 18}px`;
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

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cam = this.camera;
    if (!w || !h) return;

    // --- night-leather backdrop with faint stars ---
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

    // ring guides
    const [cx, cy] = cam.toScreen(0, 0);
    for (let d = 1; d <= this.depth; d++) {
      ctx.beginPath();
      ctx.arc(cx, cy, 260 * d * cam.k, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(201,151,59,0.09)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- edges ---
    const hotSet = new Set();
    if (this.hovered !== null) {
      hotSet.add(this.hovered);
      for (const [i, j] of this.edges) {
        if (i === this.hovered) hotSet.add(j);
        if (j === this.hovered) hotSet.add(i);
      }
    }
    for (const [i, j] of this.edges) {
      const a = this.nodes[i];
      const b = this.nodes[j];
      const [x1, y1] = cam.toScreen(a.x, a.y);
      const [x2, y2] = cam.toScreen(b.x, b.y);
      const hot = this.hovered !== null && (i === this.hovered || j === this.hovered);
      const mx = (x1 + x2) / 2 + (y2 - y1) * 0.07;
      const my = (y1 + y2) / 2 - (x2 - x1) * 0.07;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx, my, x2, y2);
      ctx.strokeStyle = hot ? 'rgba(238,194,114,0.85)' : 'rgba(201,151,59,0.22)';
      ctx.lineWidth = hot ? 1.8 : 1;
      ctx.stroke();
    }

    // --- nodes ---
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const [x, y] = cam.toScreen(node.x, node.y);
      if (x < -160 || y < -40 || x > w + 160 || y > h + 40) continue;
      const isCenter = node.depth === 0;
      const isHub = !isCenter && this.hubs.has(node.id);
      const hot = i === this.hovered || hotSet.has(i);
      const cw = this._chipW(node, ctx);
      const ch = isCenter ? 32 : 24;

      ctx.beginPath();
      ctx.roundRect(x - cw / 2, y - ch / 2, cw, ch, 3);
      if (isCenter) {
        const g = ctx.createLinearGradient(x, y - ch / 2, x, y + ch / 2);
        g.addColorStop(0, '#e2b466');
        g.addColorStop(1, '#9c6f24');
        ctx.fillStyle = g;
      } else if (isHub) {
        // planar hubs glow otherworldly blue amid the brass
        ctx.fillStyle = hot ? '#2c3d52' : '#22303f';
      } else {
        ctx.fillStyle = hot ? '#33270f' : '#241c11';
      }
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.strokeStyle = isCenter
        ? '#f4d79b'
        : isHub
          ? hot ? '#b4d4f2' : 'rgba(126,166,206,0.65)'
          : hot
            ? 'rgba(238,194,114,0.95)'
            : 'rgba(201,151,59,0.4)';
      ctx.lineWidth = isCenter ? 1.6 : 1;
      ctx.stroke();

      ctx.font = isCenter ? '700 13px "Cinzel", serif' : '500 11.5px "Alegreya Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isCenter ? '#241605' : isHub ? (hot ? '#e2eefa' : '#c4d8ea') : hot ? '#f4e2b8' : PARCH;
      ctx.fillText(node.name, x, y + 0.5);
    }

    // truncation note
    if (this.truncated > 0) {
      ctx.font = '500 11px "Alegreya Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(233,220,195,0.5)';
      ctx.fillText(`showing the nearest ${MAX_NODES} zones — ${this.truncated} more beyond`, 16, h - 14);
    }
  }
}
