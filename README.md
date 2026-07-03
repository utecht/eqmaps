# Norrath Atlas

A browser map atlas for EverQuest Legends, built on
[Brewall's map pack](http://www.eqmaps.info). Click the brass diamonds to
travel between zones; right-click to zoom out to the **World Web**, a chart of
zone connections. `/` searches zones, and dungeons get an elevation filter.

## Running

It's a fully static site — serve the repo root over HTTP:

```sh
python3 -m http.server 8177
# open http://localhost:8177
```

Deploying means copying the whole tree (`index.html`, `css/`, `js/`, `data/`,
`maps/`) to any static host.

## Rebuilding the zone data

`data/zones.json` (zone index + connection graph) is generated from the map
files:

```sh
node scripts/build-data.mjs
```

Zone connections come from `to_Zone_Name` labels in the maps, matched against
the name table in `scripts/zone-names.mjs`. Labels that don't resolve are
listed in `data/report.json` — fix by adding entries to `ALIASES` in
`zone-names.mjs` and rebuilding. Ambiguous names prefer classic-era zones,
since that's what EQ Legends runs.

Maps in `maps/` are Brewall's work — see `other_repos/brewall-maps` for the
source drop (not committed).
