# ⚡ World Energy Dashboard

An interactive dashboard of electricity **capacity** (GW) and **generation** (TWh)
for every country, broken down by fuel type — solar, wind, hydro, bioenergy,
other renewables, nuclear, gas, coal, other fossil (incl. oil), and a reserved
**fusion** slot for the day grid-scale fusion data appears.

- **World choropleth** coloured by magnitude or by clean-energy share.
- **Ranked, fuel-segmented bars** — filter to Top 10 / Top 25 / All, by region, or search.
- **Country detail panel** — totals, world rank & share, a fuel-mix donut, a
  by-type breakdown (renewables / nuclear / fossil / fusion), the full fuel
  table, and a capacity/generation trend since 2000.
- **Self-updating** — a month-end scheduled task re-pulls the source data.

## Data source

[**Ember — Yearly Electricity Data**](https://ember-energy.org/data/yearly-electricity-data/)
(`yearly_full_release_long_format.csv`), CC BY 4.0. ~215 countries, 2000–2025,
with both installed capacity and actual generation per fuel. Country names,
flags, ISO-2 and numeric codes come from
[mledoze/countries](https://github.com/mledoze/countries) (bundled, static).
The world map is [world-atlas](https://github.com/topojson/world-atlas)
`countries-110m` (bundled).

> **Cadence note:** Ember refreshes the underlying dataset roughly **twice a
> year**, not monthly. The month-end task runs every month as requested, but most
> months it simply re-fetches the same release (a no-op). The pipeline is ready
> the moment a new release lands. "Other fossil" includes oil; each country uses
> its latest available year, which can differ between capacity and generation.

## View it

The dashboard is a static site that reads `public/energy.json`, so it must be
served over HTTP (not opened as a `file://`).

```powershell
# from the project root
C:\Python314\python.exe -m http.server 5178 --directory public
# then open http://localhost:5178
```

It's also wired into the Mission Control preview launcher as **`energy-dashboard`**
(port 5178).

## Refresh the data

```powershell
# Download the latest Ember release and rebuild public/energy.json
C:\Python314\python.exe scripts\refresh_data.py

# Rebuild from the cached CSV without re-downloading (fast)
C:\Python314\python.exe scripts\refresh_data.py --skip-download
```

The script is defensive: a failed download falls back to the cached CSV and the
previous `energy.json` is left intact (atomic writes). Progress is logged to
both stdout and `data/refresh.log`.

## Automatic monthly update

A Windows Task Scheduler job, **"Energy Dashboard Monthly Refresh"**, runs
`scripts\run_refresh.cmd` on the **last day of each month at 04:00**
(`StartWhenAvailable` is on, so a missed run — e.g. machine asleep — fires as
soon as the machine is next available).

```powershell
# Inspect / run / remove the task
schtasks /Query  /TN "Energy Dashboard Monthly Refresh" /V /FO LIST
schtasks /Run    /TN "Energy Dashboard Monthly Refresh"
schtasks /Delete /TN "Energy Dashboard Monthly Refresh" /F
```

> Registered on **DRCCOMPUTER**. To run it on another machine, re-register there
> (the `/Create` command is in `scripts/register_task.ps1`) and confirm the
> Python path in `scripts/run_refresh.cmd`.

## Project layout

```
energy-dashboard/
├─ public/                 # the dashboard (static, this is the served root)
│  ├─ index.html
│  ├─ app.js               # all UI logic (vanilla JS + D3)
│  ├─ styles.css
│  ├─ energy.json          # built data the dashboard reads  (committed)
│  ├─ world-110m.json      # bundled world map topology       (committed)
│  └─ vendor/              # bundled d3 + topojson-client (offline-capable)
├─ scripts/
│  ├─ refresh_data.py      # download Ember CSV -> public/energy.json
│  ├─ run_refresh.cmd      # scheduled-task wrapper
│  └─ register_task.ps1    # re-register the monthly task on a new machine
├─ data/
│  ├─ raw/                 # cached downloads (CSV git-ignored; country meta kept)
│  └─ refresh.log          # refresh history
└─ README.md
```

## Tech

Vanilla HTML/CSS/JS — no build step, no framework. D3 v7 and topojson-client are
bundled locally in `public/vendor/`, so the dashboard works fully offline once
`energy.json` exists.
