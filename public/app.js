/* World Energy Dashboard — app logic
 * Reads energy.json (built by scripts/refresh_data.py) and renders:
 *   - a world choropleth (D3 + bundled topojson)
 *   - a ranked, fuel-segmented bar list (filterable: region / top-N / search)
 *   - a country detail panel (capacity + generation, fuel mix, groups, trend)
 */
"use strict";

const state = {
  metric: "capacity",      // "capacity" | "generation"
  topN: "all",             // "all" | "25" | "10"
  region: "all",
  search: "",
  breakdown: "fuel",       // "fuel" | "group"  (detail mix view)
  mapColor: "magnitude",   // "magnitude" | "clean"
  selected: "WORLD",       // iso3 or "WORLD"
};

let DATA = null;
let COUNTRIES = [];
let WORLD110 = null;
const FUELS = [];                 // ordered fuel defs
const FUEL_BY_ID = {};
const GROUP_BY_ID = {};
const COUNTRY_BY_ISO3 = {};
const COUNTRY_BY_NUM = {};        // parseInt(ccn3) -> country (for map join)
let WORLD_ENTITY = null;
const REGION_BY_NAME = {};        // continent name -> aggregate entity
const REGION_FLAG = {
  "Africa": "🌍", "Europe": "🌍", "Asia": "🌏",
  "Oceania": "🌏", "North America": "🌎", "South America": "🌎",
};

const $ = (sel) => document.querySelector(sel);
const tooltip = () => document.getElementById("tooltip");

/* ----------------------------- helpers --------------------------------- */
function unit() { return state.metric === "capacity" ? "GW" : "TWh"; }
function metricLabel() { return state.metric === "capacity" ? "Capacity" : "Generation"; }
function otherMetric() { return state.metric === "capacity" ? "generation" : "capacity"; }

function fmt(v) {
  if (v == null || isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return d3.format(",.0f")(v);
  if (a >= 100) return d3.format(".0f")(v);
  if (a >= 10) return d3.format(".1f")(v);
  if (a > 0) return d3.format(".2f")(v);
  return "0";
}
function pct(x) {
  if (x == null || isNaN(x)) return "—";
  const p = x * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  if (p < 10) return p.toFixed(1) + "%";
  const r = Math.round(p);
  return (p < 100 && r === 100 ? 99 : r) + "%"; // never round a sub-100% share up to 100%
}

// Sum of a metric snapshot's fuels by group id.
function groupTotals(snap) {
  const out = {};
  for (const g of DATA.meta.groups) out[g.id] = 0;
  if (!snap) return out;
  for (const f of FUELS) out[f.group] += snap.fuels[f.id] || 0;
  return out;
}
// Clean share = (renewable + nuclear) / total.
function cleanShare(snap) {
  if (!snap || !snap.total) return null;
  const g = groupTotals(snap);
  return (g.renewable + g.nuclear) / snap.total;
}

// Precompute each country's clean-energy share + a global clean ranking, per
// metric, so the "Clean %" view can rank by it. Ties (e.g. several countries at
// ~100% clean) fall back to total, so larger grids rank ahead of micro-grids.
function computeCleanRanks() {
  for (const mk of ["capacity", "generation"]) {
    const list = COUNTRIES.filter((c) => c[mk] && c[mk].total > 0);
    list.forEach((c) => (c[mk].clean_share = cleanShare(c[mk])));
    list.sort((a, b) => (b[mk].clean_share - a[mk].clean_share) || (b[mk].total - a[mk].total));
    list.forEach((c, i) => (c[mk].clean_rank = i + 1));
  }
}

/* ----------------------------- init ------------------------------------ */
async function init() {
  try {
    DATA = await fetch("energy.json").then((r) => {
      if (!r.ok) throw new Error("energy.json " + r.status);
      return r.json();
    });
  } catch (err) {
    document.body.innerHTML =
      '<div style="padding:40px;color:#e6edf6;font-family:sans-serif">' +
      "<h2>Could not load energy.json</h2><p>Run <code>python scripts/refresh_data.py --skip-download</code> " +
      "and serve the <code>public/</code> folder over http.</p><pre>" + err + "</pre></div>";
    return;
  }

  DATA.meta.fuels.forEach((f) => { FUELS.push(f); FUEL_BY_ID[f.id] = f; });
  FUELS.sort((a, b) => a.order - b.order);
  DATA.meta.groups.forEach((g) => (GROUP_BY_ID[g.id] = g));
  COUNTRIES = DATA.countries;
  COUNTRIES.forEach((c) => {
    COUNTRY_BY_ISO3[c.iso3] = c;
    if (c.ccn3) COUNTRY_BY_NUM[parseInt(c.ccn3, 10)] = c;
  });
  WORLD_ENTITY = {
    iso3: "WORLD", name: "World", flag: "🌍", region: "All regions",
    capacity: DATA.meta.world.capacity,
    generation: DATA.meta.world.generation,
    trend: null,
  };
  buildRegionEntities();
  computeCleanRanks();

  // Map topology (optional — list still works without it).
  try {
    WORLD110 = await fetch("world-110m.json").then((r) => (r.ok ? r.json() : null));
  } catch { WORLD110 = null; }

  buildHeader();
  buildControls();
  buildRegionOptions();
  renderAll();
  window.addEventListener("resize", debounce(renderMap, 200));
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* --------------------------- region aggregates ------------------------- */
function blankSnap() {
  const fuels = {};
  FUELS.forEach((f) => (fuels[f.id] = 0));
  return { total: 0, year: null, fuels, _has: false };
}

// Aggregate every country into its continent, producing region "entities" that
// look like a country (capacity/generation snapshots with a fuel breakdown) so
// the detail panel can render them with the same code.
function buildRegionEntities() {
  const acc = {};
  for (const c of COUNTRIES) {
    const k = c.continent;
    if (!k) continue;
    if (!acc[k]) {
      acc[k] = { iso3: "REGION:" + k, name: k, isRegion: true, flag: REGION_FLAG[k] || "🗺️",
        countries: 0, capacity: blankSnap(), generation: blankSnap(), trend: null };
    }
    const e = acc[k];
    e.countries += 1;
    for (const mk of ["capacity", "generation"]) {
      const s = c[mk];
      if (!s) continue;
      const agg = e[mk];
      agg._has = true;
      agg.total += s.total;
      agg.year = agg.year == null ? s.year : Math.max(agg.year, s.year);
      for (const f of FUELS) agg.fuels[f.id] += s.fuels[f.id] || 0;
    }
  }
  for (const k in acc) {
    const e = acc[k];
    for (const mk of ["capacity", "generation"]) {
      const agg = e[mk];
      if (!agg._has || agg.total <= 0) { e[mk] = null; continue; }
      agg.total = Math.round(agg.total * 100) / 100;
      const w = WORLD_ENTITY[mk];
      agg.world_share = w && w.total ? agg.total / w.total : null;
      delete agg._has;
    }
    REGION_BY_NAME[k] = e;
  }
}

// The "summary" shown when no specific country is selected: the World, or the
// currently-filtered region.
function summaryEntity() {
  return state.region !== "all" && REGION_BY_NAME[state.region]
    ? REGION_BY_NAME[state.region]
    : WORLD_ENTITY;
}

/* --------------------------- header / footer --------------------------- */
function buildHeader() {
  const m = DATA.meta;
  const gen = new Date(m.generated_utc);
  const cy = m.world.capacity.year, gy = m.world.generation.year;
  const through = cy === gy ? `data through ${cy}` : `capacity ${cy} · generation ${gy}`;
  $("#subtitle").textContent =
    `${m.source} · ${m.country_count} countries · ${through}` +
    ` · refreshed ${isNaN(gen) ? m.generated_utc : gen.toISOString().slice(0, 10)}`;
  $("#footer").innerHTML =
    `Source: <a href="${m.source_url}" target="_blank" rel="noopener">${m.source}</a> ` +
    `(${m.license}). ${m.notes}`;
}

/* ----------------------------- controls -------------------------------- */
function buildControls() {
  segHandler("#metricToggle", "metric");
  segHandler("#topNToggle", "topn", "topN");
  segHandler("#mapColorToggle", "mapcolor", "mapColor");

  $("#regionSelect").addEventListener("change", (e) => {
    state.region = e.target.value;
    state.selected = "WORLD"; // show the region (or world) summary, not a stale country
    renderAll();
  });
  $("#searchInput").addEventListener("input", debounce((e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderBars();
    renderMap();
  }, 120));
}

// Wire a segmented control: data-<attr> on buttons -> state[key].
// `render` lets a control re-render only the part it affects (default: everything).
function segHandler(sel, attr, key, render) {
  key = key || attr;
  render = render || renderAll;
  const root = $(sel);
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const val = btn.dataset[attr];
    if (val === undefined || String(state[key]) === val) return;
    state[key] = val;
    root.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
}

function buildRegionOptions() {
  const regions = Array.from(new Set(COUNTRIES.map((c) => c.continent).filter(Boolean))).sort();
  const sel = $("#regionSelect");
  sel.innerHTML =
    '<option value="all">All regions</option>' +
    regions.map((r) => `<option value="${r}">${r}</option>`).join("");
}

/* --------------------------- filtering --------------------------------- */
function filteredCountries() {
  let list = COUNTRIES.filter((c) => c[state.metric] && c[state.metric].total > 0);
  if (state.region !== "all") list = list.filter((c) => c.continent === state.region);
  if (state.search) {
    list = list.filter((c) =>
      c.name.toLowerCase().includes(state.search) ||
      (c.name_ember || "").toLowerCase().includes(state.search) ||
      (c.iso3 || "").toLowerCase().includes(state.search));
  }
  const clean = state.mapColor === "clean";
  list.sort((a, b) => {
    if (clean) {
      const d = (b[state.metric].clean_share ?? -1) - (a[state.metric].clean_share ?? -1);
      if (d) return d;
    }
    return b[state.metric].total - a[state.metric].total;
  });
  if (state.topN !== "all") list = list.slice(0, parseInt(state.topN, 10));
  return list;
}

/* ----------------------------- render all ------------------------------ */
function renderAll() {
  $("#mapMetricLabel").textContent =
    `· ${metricLabel().toLowerCase()} (${unit()})`;
  $("#barsTitle").textContent = state.mapColor === "clean"
    ? `Countries ranked by clean-energy share (${metricLabel().toLowerCase()})`
    : `Countries ranked by ${metricLabel().toLowerCase()}`;
  renderFuelLegend();
  renderMap();
  renderBars();
  renderDetail();
}

function renderFuelLegend() {
  $("#fuelLegend").innerHTML = FUELS
    .filter((f) => f.id !== "fusion")
    .map((f) => `<span class="chip"><span class="swatch" style="background:${f.color}"></span>${f.label}</span>`)
    .join("");
}

/* ------------------------------- map ----------------------------------- */
function renderMap() {
  const host = $("#map");
  if (!WORLD110 || typeof topojson === "undefined" || typeof d3 === "undefined") {
    host.innerHTML =
      '<p class="muted" style="padding:20px">World map unavailable (topology not loaded). ' +
      "The ranked list below has every country.</p>";
    $("#mapLegend").innerHTML = "";
    return;
  }
  const width = host.clientWidth || 720;
  const height = 360;
  host.innerHTML = "";

  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  const features = topojson.feature(WORLD110, WORLD110.objects.countries).features;
  const projection = d3.geoNaturalEarth1().fitSize([width, height - 6], { type: "Sphere" });
  const path = d3.geoPath(projection);

  svg.append("path").attr("class", "sphere").attr("d", path({ type: "Sphere" }));

  // Which countries are "in focus" given current filters.
  const focus = new Set(filteredCountries().map((c) => c.ccn3 && parseInt(c.ccn3, 10)).filter(Boolean));
  const filtersActive = state.topN !== "all" || state.region !== "all" || !!state.search;

  const scale = mapColorScale();

  const paths = svg.append("g").selectAll("path")
    .data(features).join("path")
    .attr("d", path)
    .attr("class", (d) => {
      const c = COUNTRY_BY_NUM[parseInt(d.id, 10)];
      const inFocus = !filtersActive || focus.has(parseInt(d.id, 10));
      let cls = "country";
      if (!c || !c[state.metric] || !inFocus) cls += " dim";
      if (c && c.iso3 === state.selected) cls += " selected";
      return cls;
    })
    .attr("fill", (d) => {
      const c = COUNTRY_BY_NUM[parseInt(d.id, 10)];
      const inFocus = !filtersActive || focus.has(parseInt(d.id, 10));
      if (!c || !c[state.metric] || !inFocus) return "#1b2334";
      return scale.fill(c[state.metric]);
    })
    .on("mousemove", (e, d) => {
      const c = COUNTRY_BY_NUM[parseInt(d.id, 10)];
      if (c && c[state.metric]) showCountryTooltip(e, c);
      else showTooltip(e, `<div class="tt-title">${d.properties.name}</div><div class="tt-row muted">No data</div>`);
    })
    .on("mouseleave", hideTooltip)
    .on("click", (e, d) => {
      const c = COUNTRY_BY_NUM[parseInt(d.id, 10)];
      if (c && c[state.metric]) select(c.iso3);
    });

  // Native <title> for hover + screen-reader access to each country.
  paths.append("title").text((d) => {
    const c = COUNTRY_BY_NUM[parseInt(d.id, 10)];
    return c && c[state.metric]
      ? `${c.name}: ${fmt(c[state.metric].total)} ${unit()} (rank #${c[state.metric].rank})`
      : `${d.properties.name}: no data`;
  });

  renderMapLegend(scale);
}

function mapColorScale() {
  if (state.mapColor === "clean") {
    const interp = d3.scaleSequential([0, 1], d3.interpolateRdYlGn);
    return {
      fill: (snap) => { const cs = cleanShare(snap); return cs == null ? "#1b2334" : interp(cs); },
      kind: "clean",
      stops: d3.range(0, 1.0001, 0.1).map((t) => d3.interpolateRdYlGn(t)),
      min: "0% clean", max: "100% clean",
    };
  }
  const max = d3.max(COUNTRIES, (c) => (c[state.metric] ? c[state.metric].total : 0)) || 1;
  const interp = d3.scaleSequentialSqrt([0, max], d3.interpolateYlGnBu);
  return {
    fill: (snap) => interp(snap.total),
    kind: "magnitude",
    stops: d3.range(0, 1.0001, 0.1).map((t) => d3.interpolateYlGnBu(t)),
    min: "0", max: fmt(max) + " " + unit(),
  };
}

function renderMapLegend(scale) {
  const grad = `linear-gradient(90deg, ${scale.stops.join(",")})`;
  $("#mapLegend").innerHTML =
    `<span>${scale.min}</span><div class="grad" style="background:${grad}"></div><span>${scale.max}</span>` +
    `<span style="margin-left:auto">${scale.kind === "clean" ? "Renewables + nuclear share" : metricLabel()}</span>`;
}

/* ------------------------------- bars ---------------------------------- */
function renderBars() {
  const list = filteredCountries();
  const host = $("#bars");
  const empty = $("#barsEmpty");
  if (!list.length) { host.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;

  const clean = state.mapColor === "clean";
  const maxTotal = d3.max(list, (c) => c[state.metric].total) || 1;
  const orderedFuels = FUELS.filter((f) => f.id !== "fusion");

  host.innerHTML = list.map((c) => {
    const snap = c[state.metric];
    // Clean view: full-width composition bars (clean fuels sit left, so the
    // green portion's length reads as cleanliness). Magnitude view: width ∝ total.
    const widthPct = clean ? 100 : (snap.total / maxTotal) * 100;
    const segs = orderedFuels.map((f) => {
      const v = snap.fuels[f.id] || 0;
      if (v <= 0) return "";
      const w = (v / snap.total) * 100;
      return `<div class="bar-seg" style="width:${w}%;background:${f.color}"` +
        segTooltipAttr(f, v, snap) + `></div>`;
    }).join("");
    const rank = clean ? snap.clean_rank : snap.rank;
    const valueHtml = clean
      ? `${pct(snap.clean_share)}<span class="u"> clean · ${fmt(snap.total)} ${unit()}</span>`
      : `${fmt(snap.total)}<span class="u">${unit()}</span>`;
    const sel = c.iso3 === state.selected ? " selected" : "";
    const aria = clean
      ? `${c.name}, ${pct(snap.clean_share)} clean energy, rank ${rank}`
      : `${c.name}, rank ${rank}, ${fmt(snap.total)} ${unit()}`;
    return (
      `<div class="bar-row${sel}" role="button" tabindex="0" data-iso3="${c.iso3}" aria-label="${aria}">` +
        `<span class="bar-rank">${rank}</span>` +
        `<span class="bar-flag">${c.flag || "🏳️"}</span>` +
        `<div class="bar-main">` +
          `<div class="bar-name">${c.name}</div>` +
          `<div class="bar-track" style="width:${Math.max(widthPct, 2)}%">${segs}</div>` +
        `</div>` +
        `<span class="bar-value">${valueHtml}</span>` +
      `</div>`
    );
  }).join("");

  host.querySelectorAll(".bar-row").forEach((row) => {
    row.addEventListener("click", () => select(row.dataset.iso3));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(row.dataset.iso3); }
    });
  });
  host.querySelectorAll(".bar-seg").forEach((seg) => {
    seg.addEventListener("mousemove", (e) => showTooltip(e, seg.dataset.tt));
    seg.addEventListener("mouseleave", hideTooltip);
  });
}

// Build a data-tt tooltip attribute for a bar segment.
function segTooltipAttr(f, v, snap) {
  const tt = `<div class="tt-title"><span class="swatch" style="background:${f.color}"></span>${f.label}</div>` +
    `<div class="tt-row"><span>${metricLabel()}</span><b>${fmt(v)} ${unit()}</b></div>` +
    `<div class="tt-row"><span>Share</span><b>${pct(v / snap.total)}</b></div>`;
  return ` data-tt="${tt.replace(/"/g, "&quot;")}"`;
}

/* ------------------------------ detail --------------------------------- */
function select(iso3) {
  state.selected = iso3;
  renderBars();   // update selected highlight
  renderMap();
  renderDetail();
  if (window.innerWidth <= 980) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDetail() {
  const isSummary = state.selected === "WORLD";          // World or a region aggregate
  const e = isSummary ? summaryEntity() : COUNTRY_BY_ISO3[state.selected];
  if (!e) { state.selected = "WORLD"; return renderDetail(); }
  const isWorld = e.iso3 === "WORLD";
  const snap = e[state.metric];
  const host = $("#detail");

  // Back button: country -> its summary (world/region); region -> World.
  let backLabel = null, backAction = null;
  if (!isSummary) {
    const sum = summaryEntity();
    backLabel = `${sum.flag} ${sum.name}`;
    backAction = "summary";
  } else if (e.isRegion) {
    backLabel = "🌍 World";
    backAction = "world";
  }

  let sub;
  if (isWorld) sub = "All regions";
  else if (e.isRegion) sub = `Region · ${e.countries} countries`;
  else sub = (e.region || e.continent || "") + (e.iso3 ? " · " + e.iso3 : "");

  const head =
    `<div class="detail-head">` +
      `<span class="detail-flag">${e.flag || "🏳️"}</span>` +
      `<div class="detail-title"><h2>${e.name}</h2><div class="region">${sub}</div></div>` +
      (backLabel ? `<button class="back-btn" id="backBtn" data-back="${backAction}">${backLabel}</button>` : "") +
    `</div>`;

  const cards = ["capacity", "generation"].map((mk) => {
    const s = e[mk];
    const active = mk === state.metric ? " active" : "";
    const u = mk === "capacity" ? "GW" : "TWh";
    const lbl = mk === "capacity" ? "Capacity" : "Generation";
    if (!s) {
      return `<div class="stat-card" data-metric="${mk}"><div class="label">${lbl}</div>` +
        `<div class="value">—</div><div class="sub">no data</div></div>`;
    }
    let info;
    if (isWorld) info = `<span class="sub">Global total</span>`;
    else if (e.isRegion) info = `<span class="sub"><b>${pct(s.world_share)}</b> of world · ${e.countries} countries</span>`;
    else info = `<span class="sub">Rank <b>#${s.rank}</b> · <b>${pct(s.world_share)}</b> of world</span>`;
    return (
      `<div class="stat-card${active}" data-metric="${mk}">` +
        `<div class="label">${lbl}<span class="year-badge">${s.year}</span></div>` +
        `<div class="value">${fmt(s.total)}<span class="u">${u}</span></div>` +
        info +
      `</div>`
    );
  }).join("");

  let body;
  if (snap && snap.total > 0) {
    body = renderMix(e, snap)
      + (isSummary ? regionComparison() : renderTrend(e))
      + (isSummary ? "" : cfCaveat(e))
      + fusionNote(snap);
  } else {
    body = `<p class="muted" style="margin-top:16px">No ${metricLabel().toLowerCase()} data for ${e.name}.</p>`;
  }

  host.innerHTML = head + `<div class="stat-cards">${cards}</div>` + body;

  // wire interactions
  const back = $("#backBtn");
  if (back) back.addEventListener("click", () => {
    if (back.dataset.back === "world") {
      state.region = "all";
      $("#regionSelect").value = "all";
    }
    select("WORLD");
  });
  host.querySelectorAll(".stat-card[data-metric]").forEach((card) => {
    card.addEventListener("click", () => {
      const mk = card.dataset.metric;
      if (mk === state.metric || !e[mk]) return;
      state.metric = mk;
      $("#metricToggle").querySelectorAll("button").forEach((b) =>
        b.classList.toggle("active", b.dataset.metric === mk));
      renderAll();
    });
  });
  host.querySelectorAll(".region-row").forEach((row) => {
    const go = () => selectRegion(row.dataset.region);
    row.addEventListener("click", go);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
    });
  });
  // Breakdown only affects the detail panel — re-render just that subtree.
  const bd = $("#breakdownToggle");
  if (bd) segHandler("#breakdownToggle", "breakdown", "breakdown", renderDetail);
}

// Filter to a region and show its summary (used by the region-comparison rows).
function selectRegion(name) {
  if (!REGION_BY_NAME[name]) return;
  state.region = name;
  $("#regionSelect").value = name;
  state.selected = "WORLD";
  renderAll();
}

// Region comparison: each continent's total for the active metric, as a
// group-segmented bar, sorted desc. Shown in the World/region summary only.
function regionComparison() {
  const clean = state.mapColor === "clean";
  const regions = Object.values(REGION_BY_NAME)
    .filter((r) => r[state.metric] && r[state.metric].total > 0)
    .map((r) => ({ r, cs: cleanShare(r[state.metric]) }))
    .sort((a, b) => clean ? (b.cs - a.cs) : (b.r[state.metric].total - a.r[state.metric].total))
    .map((x) => x.r);
  if (regions.length < 2) return "";
  const max = d3.max(regions, (r) => r[state.metric].total) || 1;
  const rows = regions.map((r) => {
    const s = r[state.metric];
    const widthPct = clean ? 100 : Math.max((s.total / max) * 100, 3);
    const gt = groupTotals(s);
    const segs = DATA.meta.groups.map((g) => {
      const v = gt[g.id];
      return v > 0 ? `<div class="rr-seg" style="width:${(v / s.total) * 100}%;background:${g.color}"></div>` : "";
    }).join("");
    const selCls = state.region === r.name ? " selected" : "";
    const valHtml = clean
      ? `${pct(cleanShare(s))}<span class="u"> clean</span>`
      : `${fmt(s.total)}<span class="u">${unit()}</span> · ${pct(s.world_share)}`;
    const aria = clean
      ? `${r.name}, ${pct(cleanShare(s))} clean energy`
      : `${r.name}, ${fmt(s.total)} ${unit()}, ${pct(s.world_share)} of world`;
    return (
      `<div class="region-row${selCls}" data-region="${r.name}" role="button" tabindex="0" aria-label="${aria}">` +
        `<div class="rr-head"><span class="rr-name">${r.flag} ${r.name}</span>` +
          `<span class="rr-val">${valHtml}</span></div>` +
        `<div class="rr-track"><div class="rr-fill" style="width:${widthPct}%">${segs}</div></div>` +
      `</div>`
    );
  }).join("");
  const heading = clean ? "Clean-energy share by region" : `${metricLabel()} by region`;
  return `<div class="detail-section-head"><h3>${heading}</h3>` +
    `<span class="muted" style="font-size:11px">click to filter</span></div>` +
    `<div class="region-compare">${rows}</div>`;
}

function renderMix(e, snap) {
  const headToggle =
    `<div class="detail-section-head"><h3>${metricLabel()} mix</h3>` +
    `<div class="seg small" id="breakdownToggle">` +
      `<button data-breakdown="fuel" class="${state.breakdown === "fuel" ? "active" : ""}" type="button">By fuel</button>` +
      `<button data-breakdown="group" class="${state.breakdown === "group" ? "active" : ""}" type="button">By type</button>` +
    `</div></div>`;

  // Donut slices depend on breakdown mode.
  let slices;
  if (state.breakdown === "group") {
    const gt = groupTotals(snap);
    slices = DATA.meta.groups
      .map((g) => ({ label: g.label, color: g.color, value: gt[g.id], id: g.id }))
      .filter((s) => s.value > 0);
  } else {
    slices = FUELS
      .map((f) => ({ label: f.label, color: f.color, value: snap.fuels[f.id] || 0, id: f.id }))
      .filter((s) => s.value > 0);
  }

  const donut = donutSVG(slices, snap.total);
  const groups = groupBars(snap);
  const legend = legendTable(snap);

  return headToggle +
    `<div class="mix-wrap">${donut}<div class="group-bars">${groups}</div></div>` +
    legend;
}

function donutSVG(slices, total) {
  const size = 132, r = size / 2, inner = r * 0.62;
  const arc = d3.arc().innerRadius(inner).outerRadius(r - 2);
  const pie = d3.pie().sort(null).value((d) => d.value);
  const arcs = pie(slices);
  const paths = arcs.map((a) =>
    `<path d="${arc(a)}" fill="${a.data.color}" transform="translate(${r},${r})">` +
    `<title>${a.data.label}: ${fmt(a.data.value)} ${unit()} (${pct(a.data.value / total)})</title></path>`
  ).join("");
  return (
    `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      paths +
      `<text class="donut-center-total" x="${r}" y="${r - 2}" text-anchor="middle">${fmt(total)}</text>` +
      `<text class="donut-center-label" x="${r}" y="${r + 12}" text-anchor="middle">${unit()}</text>` +
    `</svg>`
  );
}

function groupBars(snap) {
  const gt = groupTotals(snap);
  return DATA.meta.groups.map((g) => {
    const v = gt[g.id];
    const share = snap.total ? v / snap.total : 0;
    const isFusion = g.id === "fusion";
    if (isFusion && v <= 0) return ""; // fusion handled in fusionNote when zero
    return (
      `<div class="group-bar">` +
        `<div class="gb-top"><span class="name"><span class="swatch" style="background:${g.color}"></span>${g.label}</span>` +
          `<span class="val">${fmt(v)} ${unit()} · ${pct(share)}</span></div>` +
        `<div class="gb-track"><div class="gb-fill" style="width:${share * 100}%;background:${g.color}"></div></div>` +
      `</div>`
    );
  }).join("");
}

function legendTable(snap) {
  const rows = FUELS
    .map((f) => ({ f, v: snap.fuels[f.id] || 0 }))
    .sort((a, b) => b.v - a.v)
    .map(({ f, v }) => {
      const zero = v <= 0 ? " zero" : "";
      return (
        `<div class="legend-row${zero}">` +
          `<span class="swatch" style="background:${f.color}"></span>` +
          `<span class="lr-name">${f.label}</span>` +
          `<span class="lr-val">${v > 0 ? fmt(v) + " " + unit() : "—"}</span>` +
          `<span class="lr-pct">${v > 0 ? pct(v / snap.total) : "—"}</span>` +
        `</div>`
      );
    }).join("");
  return `<div class="detail-section-head"><h3>All fuels</h3></div><div class="legend-table">${rows}</div>`;
}

function renderTrend(e) {
  const t = e.trend;
  if (!t || !t.years || !t.years.length) return "";
  const series = t[state.metric];
  const pts = t.years.map((y, i) => ({ y, v: series[i] })).filter((d) => d.v != null);
  if (pts.length < 2) return "";
  const w = 340, h = 70, pad = 2;
  const x = d3.scaleLinear().domain(d3.extent(pts, (d) => d.y)).range([pad, w - pad]);
  const y = d3.scaleLinear().domain([0, d3.max(pts, (d) => d.v) || 1]).range([h - pad, pad + 6]);
  const area = d3.area().x((d) => x(d.y)).y0(h - pad).y1((d) => y(d.v)).curve(d3.curveMonotoneX);
  const line = d3.line().x((d) => x(d.y)).y((d) => y(d.v)).curve(d3.curveMonotoneX);
  const last = pts[pts.length - 1], first = pts[0];
  return (
    `<div class="trend-wrap"><div class="detail-section-head" style="margin-bottom:6px"><h3>Total ${metricLabel().toLowerCase()} over time</h3></div>` +
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1">` +
        `<stop offset="0%" stop-color="${GROUP_BY_ID.renewable.color}" stop-opacity="0.45"/>` +
        `<stop offset="100%" stop-color="${GROUP_BY_ID.renewable.color}" stop-opacity="0.02"/></linearGradient></defs>` +
      `<path d="${area(pts)}" fill="url(#tg)"/>` +
      `<path d="${line(pts)}" fill="none" stroke="${GROUP_BY_ID.renewable.color}" stroke-width="1.8"/>` +
      `<circle cx="${x(last.y)}" cy="${y(last.v)}" r="2.6" fill="${GROUP_BY_ID.renewable.color}"/>` +
    `</svg>` +
    `<div class="trend-meta"><span>${first.y}: ${fmt(first.v)} ${unit()}</span>` +
      `<span>${last.y}: ${fmt(last.v)} ${unit()}</span></div></div>`
  );
}

function fusionNote(snap) {
  const fusion = snap.fuels.fusion || 0;
  if (fusion > 0) return ""; // real data present -> already shown
  return `<div class="fusion-note"><b>Fusion</b>: reserved in the dataset and reading 0 — ` +
    `no grid-scale fusion capacity is reported yet. This row lights up automatically if Ember ever publishes it.</div>`;
}

// Upstream data caveat: fuels whose generation exceeds what their reported
// capacity can physically produce (flagged by the pipeline in country.cf_flags).
function cfCaveat(e) {
  if (!e.cf_flags || !e.cf_flags.length) return "";
  const fuels = e.cf_flags.map((f) => (FUEL_BY_ID[f.fuel] || {}).label || f.fuel).join(", ");
  return `<div class="fusion-note caveat"><b>⚠ Data caveat</b>: reported <b>${fuels}</b> ` +
    `capacity looks low next to its generation — usually an upstream capacity-reporting lag ` +
    `(fast-growing solar is the common cause). Figures are shown exactly as Ember published them.</div>`;
}

/* ----------------------------- tooltip --------------------------------- */
function showCountryTooltip(e, c) {
  const snap = c[state.metric];
  const cs = cleanShare(snap);
  const html =
    `<div class="tt-title">${c.flag || ""} ${c.name}</div>` +
    `<div class="tt-row"><span>${metricLabel()}</span><b>${fmt(snap.total)} ${unit()}</b></div>` +
    `<div class="tt-row"><span>World rank</span><b>#${snap.rank}</b></div>` +
    `<div class="tt-row"><span>Clean share</span><b>${pct(cs)}</b></div>`;
  showTooltip(e, html);
}
function showTooltip(e, html) {
  const tt = tooltip();
  tt.innerHTML = html;
  tt.hidden = false;
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const rect = tt.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
  tt.style.left = x + "px";
  tt.style.top = y + "px";
}
function hideTooltip() { tooltip().hidden = true; }

document.addEventListener("DOMContentLoaded", init);
