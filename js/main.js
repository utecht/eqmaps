import { parseMapText } from './parser.js';
import { MapViewer } from './viewer.js';
import { GraphView } from './graph.js';

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  names: new Map(),
  adjacency: new Map(),
  cache: new Map(), // short -> parsed zone (LRU, cap 24)
  current: null,
  prev: null,
  view: 'map',
  recents: JSON.parse(localStorage.getItem('eqatlas-recents') || '[]'),
};

const viewer = new MapViewer($('map-canvas'), $('tooltip'));
const graph = new GraphView($('graph-canvas'), $('tooltip'));

// Teleport-hub planes connect to half the world; the world web hides
// routes through them unless "Portals" is toggled on.
const HUBS = new Set(['poknowledge', 'potranquility']);

// ---------- data loading ----------

async function loadIndex() {
  const res = await fetch('data/zones.json');
  state.data = await res.json();
  for (const [short, z] of Object.entries(state.data.zones)) {
    state.names.set(short, z.name);
  }
  for (const [short, z] of Object.entries(state.data.zones)) {
    if (!state.adjacency.has(short)) state.adjacency.set(short, new Set());
    for (const l of z.links) {
      if (!state.data.zones[l.t]) continue;
      state.adjacency.get(short).add(l.t);
      if (!state.adjacency.has(l.t)) state.adjacency.set(l.t, new Set());
      state.adjacency.get(l.t).add(short);
    }
  }
  graph.setWorld(state.adjacency, state.names, HUBS);
}

async function loadZone(short) {
  if (state.cache.has(short)) {
    const z = state.cache.get(short);
    state.cache.delete(short);
    state.cache.set(short, z); // refresh LRU position
    return z;
  }
  const meta = state.data.zones[short];
  if (!meta) throw new Error(`Unknown zone: ${short}`);
  const layers = await Promise.all(
    meta.layers.map(async ([n, file]) => {
      try {
        const res = await fetch(`maps/${encodeURIComponent(file)}`);
        if (!res.ok) return null;
        const parsed = parseMapText(await res.text());
        return { n, ...parsed };
      } catch {
        return null;
      }
    })
  );
  const zone = {
    short,
    meta,
    layers: layers.filter(Boolean),
    links: meta.links.map((l) => ({ ...l, name: state.names.get(l.t) || l.l })),
  };
  state.cache.set(short, zone);
  if (state.cache.size > 24) state.cache.delete(state.cache.keys().next().value);
  return zone;
}

// ---------- routing ----------

function go(short, view = 'map') {
  location.hash = view === 'web' ? `#/w/${short}` : `#/z/${short}`;
}

function parseHash() {
  const m = location.hash.match(/^#\/(z|w)\/([a-z0-9_]+)/i);
  if (m && state.data.zones[m[2].toLowerCase()]) {
    return { view: m[1] === 'w' ? 'web' : 'map', short: m[2].toLowerCase() };
  }
  return { view: 'map', short: 'poknowledge' };
}

let routeSeq = 0;
async function route() {
  const { view, short } = parseHash();
  const seq = ++routeSeq;
  const arrivedFrom = state.prev;

  $('btn-map').classList.toggle('active', view === 'map');
  $('btn-web').classList.toggle('active', view === 'web');
  $('map-canvas').hidden = view !== 'map';
  $('graph-canvas').hidden = view !== 'web';
  $('web-controls').hidden = view !== 'web';
  $('compass').style.display = view === 'map' ? '' : 'none';
  $('zoom-controls').style.display = view === 'map' ? '' : 'none';
  $('tooltip').hidden = true;
  $('hint-bar').innerHTML =
    view === 'map'
      ? 'drag to pan &middot; scroll to zoom &middot; <b>right-click</b> for the world web &middot; <b>/</b> to search'
      : 'click a zone to open its map &middot; <b>right-click</b> or <b>esc</b> to return';

  const meta = state.data.zones[short];
  $('zone-title').textContent = meta.name;
  document.title = `${meta.name} · Norrath Atlas`;

  const changedZone = short !== state.current;
  state.prev = state.current;
  state.current = short;
  if (changedZone) addRecent(short);
  renderPanel(short);

  if (view === 'web') {
    $('zone-sub').textContent = 'the world web';
    graph.build(short, graph.depth);
    return;
  }

  $('loading').hidden = false;
  try {
    const zone = await loadZone(short);
    if (seq !== routeSeq) return; // superseded by a newer navigation
    viewer.setZone(zone, changedZone ? state.prev : null);
    const segs = zone.layers.reduce((a, l) => a + l.batches.reduce((x, b) => x + b.segs.length / 6, 0), 0);
    $('zone-sub').textContent = `${short} · ${segs.toLocaleString()} strokes · ${zone.links.length} passages`;
    renderZoneControls(zone);
  } catch (err) {
    $('zone-sub').textContent = 'this map failed to unfurl';
    console.error(err);
  } finally {
    if (seq === routeSeq) $('loading').hidden = true;
  }
}

// ---------- side panel ----------

function addRecent(short) {
  state.recents = [short, ...state.recents.filter((s) => s !== short)].slice(0, 7);
  localStorage.setItem('eqatlas-recents', JSON.stringify(state.recents));
}

function renderPanel(short) {
  const meta = state.data.zones[short];

  // passages, deduped by target
  const byTarget = new Map();
  for (const l of meta.links) {
    if (!state.data.zones[l.t]) continue;
    if (!byTarget.has(l.t)) byTarget.set(l.t, 0);
    byTarget.set(l.t, byTarget.get(l.t) + 1);
  }
  const ul = $('connections');
  ul.innerHTML = '';
  if (byTarget.size === 0) {
    ul.innerHTML = '<li class="none">no charted passages</li>';
  }
  for (const [t, count] of [...byTarget.entries()].sort((a, b) =>
    (state.names.get(a[0]) || '').localeCompare(state.names.get(b[0]) || '')
  )) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.innerHTML = `<span>${state.names.get(t)}</span><em>${count > 1 ? count + ' ways' : ''}</em>`;
    btn.addEventListener('click', () => go(t));
    li.appendChild(btn);
    ul.appendChild(li);
  }

  // recents
  const rul = $('recents');
  rul.innerHTML = '';
  for (const s of state.recents) {
    if (!state.data.zones[s]) continue;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = s === short ? 'here' : '';
    btn.innerHTML = `<span>${state.names.get(s)}</span>`;
    btn.addEventListener('click', () => go(s));
    li.appendChild(btn);
    rul.appendChild(li);
  }
}

function renderZoneControls(zone) {
  // layers
  const chips = $('layer-chips');
  chips.innerHTML = '';
  for (const layer of zone.layers) {
    const b = document.createElement('button');
    b.className = viewer.visibleLayers.has(layer.n) ? 'chip active' : 'chip';
    b.textContent = layer.n === 0 ? 'Base' : `Detail ${layer.n}`;
    b.addEventListener('click', () => {
      const on = !b.classList.contains('active');
      b.classList.toggle('active', on);
      viewer.setLayerVisible(layer.n, on);
    });
    chips.appendChild(b);
  }

  // elevation
  const [zmin, zmax] = viewer.zBounds();
  const sec = $('elev-sec');
  if (zmax - zmin < 20) {
    sec.hidden = true;
  } else {
    sec.hidden = false;
    const lo = $('z-min');
    const hi = $('z-max');
    lo.min = hi.min = zmin;
    lo.max = hi.max = zmax;
    lo.value = zmin;
    hi.value = zmax;
    updateElevLabel();
  }
}

function applyElev() {
  const lo = +$('z-min').value;
  const hi = +$('z-max').value;
  const [zmin, zmax] = viewer.zBounds();
  viewer.setZRange(lo <= zmin && hi >= zmax ? null : [Math.min(lo, hi), Math.max(lo, hi)]);
  updateElevLabel();
}

function updateElevLabel() {
  $('z-val').textContent = `${$('z-min').value} ⟷ ${$('z-max').value}`;
}

// ---------- search ----------

function searchZones(q) {
  const nq = q.trim().toLowerCase();
  if (!nq) return [];
  const scored = [];
  for (const [short, z] of Object.entries(state.data.zones)) {
    const name = z.name.toLowerCase();
    let score = -1;
    if (short === nq) score = 0;
    else if (name.startsWith(nq)) score = 1;
    else if (short.startsWith(nq)) score = 2;
    else if (name.includes(nq)) score = 3;
    else if (short.includes(nq)) score = 4;
    if (score >= 0) scored.push({ short, name: z.name, links: z.links.length, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, 14);
}

function setupSearch() {
  const input = $('search');
  const box = $('search-results');
  let results = [];
  let active = -1;

  const close = () => {
    box.hidden = true;
    active = -1;
  };

  const renderResults = () => {
    box.innerHTML = '';
    results.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'result' + (i === active ? ' active' : '');
      div.innerHTML = `<span>${r.name}</span><em>${r.short}</em>`;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        go(r.short, state.view === 'web' ? 'web' : 'map');
        input.blur();
        close();
      });
      box.appendChild(div);
    });
    box.hidden = results.length === 0;
  };

  input.addEventListener('input', () => {
    results = searchZones(input.value);
    active = results.length ? 0 : -1;
    renderResults();
  });
  input.addEventListener('focus', () => {
    if (input.value) {
      results = searchZones(input.value);
      renderResults();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      renderResults();
    } else if (e.key === 'Enter') {
      if (results[active]) {
        go(results[active].short, parseHash().view === 'web' ? 'web' : 'map');
        input.blur();
        close();
      }
    } else if (e.key === 'Escape') {
      input.blur();
      close();
    }
  });
}

// ---------- boot ----------

async function boot() {
  await loadIndex();
  setupSearch();

  viewer.onTravel = (t) => go(t);
  viewer.onContext = () => go(state.current, 'web');
  graph.onOpen = (id) => go(id);
  graph.onExit = () => go(state.current);

  $('btn-map').addEventListener('click', () => go(state.current || 'poknowledge'));
  $('btn-web').addEventListener('click', () => go(state.current || 'poknowledge', 'web'));
  $('z-in').addEventListener('click', () => viewer.zoomBy(1.45));
  $('z-out').addEventListener('click', () => viewer.zoomBy(1 / 1.45));
  $('z-fit').addEventListener('click', () => viewer.fitView());
  $('z-min').addEventListener('input', applyElev);
  $('z-max').addEventListener('input', applyElev);
  $('z-reset').addEventListener('click', () => {
    const [zmin, zmax] = viewer.zBounds();
    $('z-min').value = zmin;
    $('z-max').value = zmax;
    applyElev();
  });
  $('hub-toggle').addEventListener('click', () => {
    graph.hideHubRoutes = !graph.hideHubRoutes;
    $('hub-toggle').classList.toggle('active', !graph.hideHubRoutes);
    graph.build(state.current, graph.depth);
  });
  for (const btn of document.querySelectorAll('#web-controls button[data-d]')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('#web-controls button[data-d]')) b.classList.remove('active');
      btn.classList.add('active');
      graph.build(state.current, +btn.dataset.d);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '/') {
      e.preventDefault();
      $('search').focus();
      $('search').select();
    } else if (e.key === 'Escape' && parseHash().view === 'web') {
      go(state.current);
    }
  });

  window.addEventListener('hashchange', () => {
    state.view = parseHash().view;
    route();
  });
  state.view = parseHash().view;
  await route();
}

boot().catch((err) => {
  $('zone-title').textContent = 'The atlas failed to open';
  $('zone-sub').textContent = String(err);
  console.error(err);
});
