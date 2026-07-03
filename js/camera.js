// Pointer-driven pan/zoom camera shared by the map and world-web canvases.
// World → screen: sx = x * k + tx, sy = y * k + ty.

export class Camera {
  constructor() {
    this.k = 1;
    this.tx = 0;
    this.ty = 0;
    this.fitK = 1;
    this.minK = 0.0001;
    this.maxK = 5000;
    this._anim = null;
  }

  toScreen(x, y) {
    return [x * this.k + this.tx, y * this.k + this.ty];
  }

  toWorld(sx, sy) {
    return [(sx - this.tx) / this.k, (sy - this.ty) / this.k];
  }

  fit(bounds, w, h, pad = 0.08) {
    const [minX, minY, maxX, maxY] = bounds;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const k = Math.min(w / bw, h / bh) * (1 - pad * 2);
    this.k = k;
    this.fitK = k;
    this.minK = k * 0.15;
    this.maxK = k * 600;
    this.tx = w / 2 - k * (minX + maxX) / 2;
    this.ty = h / 2 - k * (minY + maxY) / 2;
  }

  zoomAt(sx, sy, factor) {
    const k = Math.min(this.maxK, Math.max(this.minK, this.k * factor));
    const real = k / this.k;
    this.tx = sx - (sx - this.tx) * real;
    this.ty = sy - (sy - this.ty) * real;
    this.k = k;
  }

  // Smoothly tween to a target {k, tx, ty}.
  animateTo(target, ms, onFrame) {
    if (this._anim) cancelAnimationFrame(this._anim);
    const from = { k: this.k, tx: this.tx, ty: this.ty };
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      this.k = from.k + (target.k - from.k) * e;
      this.tx = from.tx + (target.tx - from.tx) * e;
      this.ty = from.ty + (target.ty - from.ty) * e;
      onFrame();
      if (t < 1) this._anim = requestAnimationFrame(step);
      else this._anim = null;
    };
    this._anim = requestAnimationFrame(step);
  }

  // Wires pointer/wheel interaction to a canvas. Handlers receive CSS-pixel
  // screen coordinates relative to the canvas.
  attach(canvas, { onChange, onClick, onHover, onContext }) {
    const pointers = new Map();
    let dragged = false;
    let pinchDist = 0;

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pos(e));
      dragged = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (!pointers.has(e.pointerId)) {
        if (onHover) onHover(p[0], p[1]);
        return;
      }
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        const dx = p[0] - prev[0];
        const dy = p[1] - prev[1];
        if (Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]) > 0 ) {
          if (Math.hypot(dx, dy) > 2) dragged = true;
          this.tx += dx;
          this.ty += dy;
          onChange();
        }
      } else if (pointers.size === 2) {
        dragged = true;
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pinchDist > 0) this.zoomAt(mid[0], mid[1], d / pinchDist);
        pinchDist = d;
        onChange();
      }
    });

    const release = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      pinchDist = 0;
      if (pointers.size === 0 && !dragged && e.button === 0 && onClick) {
        const p = pos(e);
        onClick(p[0], p[1], e);
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      this.zoomAt(p[0], p[1], Math.exp(-e.deltaY * 0.0016));
      onChange();
    }, { passive: false });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (onContext) onContext();
    });
  }
}
