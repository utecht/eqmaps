// Canvas zone-map renderer: parchment surface, color-batched ink lines,
// zoom-gated labels, and brass travel markers for zone connections.

import { Camera } from './camera.js';

const PARCHMENT = '#e7d7ae';
const INK = '#3a2e1b';
const BRASS = '#a8762c';
const BRASS_BRIGHT = '#eec272';
const BRASS_DARK = '#6f4f1a';

// Subtle paper grain, generated once and tiled in map space so the paper
// appears to move with the map.
function makeGrain() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s);
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 225 + rnd() * 30 - (rnd() < 0.004 ? 38 : 0); // occasional fleck
    img.data[i] = v;
    img.data[i + 1] = v - 6;
    img.data[i + 2] = v - 30;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export class MapViewer {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.camera = new Camera();
    this.zone = null; // { short, meta, layers: [{n, batches, points, minZ, maxZ}], links }
    this.visibleLayers = new Set();
    this.zRange = null; // [min, max] or null for all
    this.hovered = null; // link index
    this.spot = null; // { x, y, t0 } entry-marker pulse
    this.onTravel = null;
    this.grain = null;
    this.grainPattern = null;
    this._raf = 0;

    this.camera.attach(canvas, {
      onChange: () => this.requestRender(),
      onHover: (sx, sy) => this._hover(sx, sy),
      onClick: (sx, sy) => this._click(sx, sy),
      onContext: () => this.onContext && this.onContext(),
    });

    const ro = new ResizeObserver(() => this._resize());
    ro.observe(canvas);
    this._resize();
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

  setZone(zone, entryFrom) {
    this.zone = zone;
    this.visibleLayers = new Set(zone.layers.map((l) => l.n));
    this.zRange = null;
    this.hovered = null;
    this.spot = null;
    for (const layer of zone.layers) layer.paths = null; // rebuild Path2D cache

    this.camera.fit(zone.meta.bounds, this.canvas.clientWidth, this.canvas.clientHeight);

    // Pulse the marker we just arrived through, so you know where you stand.
    if (entryFrom) {
      const back = zone.links.find((l) => l.t === entryFrom);
      if (back) this.spot = { x: back.x, y: back.y, t0: performance.now() };
    }

    // Small settle-in: start 8% wide and ease to fit.
    const fit = { k: this.camera.k, tx: this.camera.tx, ty: this.camera.ty };
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.camera.k = fit.k * 0.92;
    this.camera.tx = w / 2 - (w / 2 - fit.tx) * 0.92;
    this.camera.ty = h / 2 - (h / 2 - fit.ty) * 0.92;
    this.camera.animateTo(fit, 340, () => this.requestRender());
    this.requestRender();
  }

  zBounds() {
    if (!this.zone) return [0, 0];
    let min = Infinity, max = -Infinity;
    for (const l of this.zone.layers) {
      if (l.minZ < min) min = l.minZ;
      if (l.maxZ > max) max = l.maxZ;
    }
    if (min === Infinity) return [0, 0];
    return [Math.floor(min), Math.ceil(max)];
  }

  setLayerVisible(n, on) {
    if (on) this.visibleLayers.add(n);
    else this.visibleLayers.delete(n);
    this.requestRender();
  }

  setZRange(range) {
    this.zRange = range;
    this.requestRender();
  }

  fitView() {
    if (!this.zone) return;
    const target = new Camera();
    target.fit(this.zone.meta.bounds, this.canvas.clientWidth, this.canvas.clientHeight);
    this.camera.animateTo({ k: target.k, tx: target.tx, ty: target.ty }, 300, () => this.requestRender());
  }

  zoomBy(f) {
    this.camera.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, f);
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
      // Keep animating while the entry pulse is alive.
      if (this.spot && performance.now() - this.spot.t0 < 4000) this.requestRender();
      else this.spot = null;
    });
  }

  _linkScreenPos() {
    const out = [];
    if (!this.zone) return out;
    for (let i = 0; i < this.zone.links.length; i++) {
      const l = this.zone.links[i];
      const [sx, sy] = this.camera.toScreen(l.x, l.y);
      out.push([sx, sy, i]);
    }
    return out;
  }

  _hover(sx, sy) {
    let best = null;
    let bestD = 14;
    for (const [x, y, i] of this._linkScreenPos()) {
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best !== this.hovered) {
      this.hovered = best;
      this.canvas.style.cursor = best !== null ? 'pointer' : 'grab';
      if (best !== null) {
        const l = this.zone.links[best];
        const [x, y] = this.camera.toScreen(l.x, l.y);
        this.tooltip.innerHTML = `Travel to <b>${l.name}</b>` +
          (l.l && l.l.toLowerCase() !== l.name.toLowerCase() ? `<small>${l.l}</small>` : '');
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top = `${y - 14}px`;
        this.tooltip.hidden = false;
      } else {
        this.tooltip.hidden = true;
      }
      this.requestRender();
    } else if (best !== null) {
      const l = this.zone.links[best];
      const [x, y] = this.camera.toScreen(l.x, l.y);
      this.tooltip.style.left = `${x}px`;
      this.tooltip.style.top = `${y - 14}px`;
    }
  }

  _click(sx, sy) {
    this._hover(sx, sy);
    if (this.hovered !== null && this.onTravel) {
      const l = this.zone.links[this.hovered];
      this.tooltip.hidden = true;
      this.onTravel(l.t);
    }
  }

  _inZ(z1, z2) {
    if (!this.zRange) return true;
    const [a, b] = this.zRange;
    return z1 >= a && z1 <= b && z2 >= a && z2 <= b;
  }

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cam = this.camera;
    if (!w || !h) return;

    // --- parchment ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = PARCHMENT;
    ctx.fillRect(0, 0, w, h);
    if (!this.grain) {
      this.grain = makeGrain();
      this.grainPattern = ctx.createPattern(this.grain, 'repeat');
    }
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.translate(cam.tx % 256, cam.ty % 256);
    ctx.fillStyle = this.grainPattern;
    ctx.fillRect(-256, -256, w + 512, h + 512);
    ctx.restore();

    if (!this.zone) return;

    // --- map lines ---
    ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * cam.tx, dpr * cam.ty);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const lw = Math.max(1.0, Math.min(2.2, 0.9 + cam.k / cam.fitK * 0.12)) / cam.k;
    for (const layer of this.zone.layers) {
      if (!this.visibleLayers.has(layer.n)) continue;
      if (!this.zRange) {
        if (!layer.paths) {
          layer.paths = layer.batches.map((b) => {
            const p = new Path2D();
            const s = b.segs;
            for (let i = 0; i < s.length; i += 6) {
              p.moveTo(s[i], s[i + 1]);
              p.lineTo(s[i + 3], s[i + 4]);
            }
            return p;
          });
        }
        for (let i = 0; i < layer.batches.length; i++) {
          ctx.strokeStyle = layer.batches[i].css;
          ctx.lineWidth = lw;
          ctx.stroke(layer.paths[i]);
        }
      } else {
        for (const b of layer.batches) {
          const p = new Path2D();
          const s = b.segs;
          let any = false;
          for (let i = 0; i < s.length; i += 6) {
            if (!this._inZ(s[i + 2], s[i + 5])) continue;
            p.moveTo(s[i], s[i + 1]);
            p.lineTo(s[i + 3], s[i + 4]);
            any = true;
          }
          if (!any) continue;
          ctx.strokeStyle = b.css;
          ctx.lineWidth = lw;
          ctx.stroke(p);
        }
      }
    }

    // --- point labels (screen space for crisp text) ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ratio = cam.k / cam.fitK;
    // a "to_" label is already drawn as a travel marker if a link sits nearby
    const nearLink = (pt) => this.zone.links.some((l) => {
      const dx = l.x - pt.x;
      const dy = l.y - pt.y;
      return dx * dx + dy * dy < 16;
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const layer of this.zone.layers) {
      if (!this.visibleLayers.has(layer.n)) continue;
      for (const pt of layer.points) {
        if (pt.isLink && nearLink(pt)) continue;
        if (this.zRange && !this._inZ(pt.z, pt.z)) continue;
        const need = pt.size >= 3 ? 0 : pt.size === 2 ? 1.5 : 2.8;
        if (ratio < need) continue;
        const [sx, sy] = cam.toScreen(pt.x, pt.y);
        if (sx < -80 || sy < -20 || sx > w + 80 || sy > h + 20) continue;
        const fs = pt.size >= 3 ? 12.5 : pt.size === 2 ? 11.5 : 10.5;
        ctx.font = `600 ${fs}px "Alegreya Sans", sans-serif`;
        ctx.strokeStyle = 'rgba(231,215,174,0.85)';
        ctx.lineWidth = 3;
        ctx.strokeText(pt.label, sx, sy);
        ctx.fillStyle = pt.css;
        ctx.fillText(pt.label, sx, sy);
      }
    }

    // --- entry pulse ---
    if (this.spot) {
      const t = (performance.now() - this.spot.t0) / 1000;
      const [sx, sy] = cam.toScreen(this.spot.x, this.spot.y);
      const phase = (t * 1.1) % 1;
      ctx.beginPath();
      ctx.arc(sx, sy, 10 + phase * 26, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(168,118,44,${(1 - phase) * 0.7})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // --- travel markers ---
    for (const [sx, sy, i] of this._linkScreenPos()) {
      if (sx < -120 || sy < -40 || sx > w + 120 || sy > h + 40) continue;
      const l = this.zone.links[i];
      const hot = i === this.hovered;
      const r = hot ? 8.5 : 6.5;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.PI / 4);
      if (hot) {
        ctx.shadowColor = 'rgba(238,194,114,0.9)';
        ctx.shadowBlur = 12;
      }
      const grad = ctx.createLinearGradient(-r, -r, r, r);
      grad.addColorStop(0, hot ? BRASS_BRIGHT : '#c8944a');
      grad.addColorStop(1, hot ? BRASS : BRASS_DARK);
      ctx.fillStyle = grad;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.fillStyle = hot ? '#fff3d8' : '#f3ddae';
      ctx.fillRect(-1.8, -1.8, 3.6, 3.6);
      ctx.restore();

      ctx.font = `700 10px "Cinzel", serif`;
      const name = l.name.toUpperCase();
      // alternate name placement so tightly ringed markers collide less
      const ly = i % 2 === 0 ? sy + r + 12 : sy - r - 8;
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(231,215,174,0.9)';
      ctx.lineWidth = 3.5;
      ctx.strokeText(name, sx, ly);
      ctx.fillStyle = hot ? BRASS : BRASS_DARK;
      ctx.fillText(name, sx, ly);
    }

    // --- vignette ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.78);
    vg.addColorStop(0, 'rgba(70,48,20,0)');
    vg.addColorStop(1, 'rgba(52,34,12,0.32)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }
}
