#!/usr/bin/env python3
"""
fix_map_territories.py — split French overseas departments out of France's map shape.

The bundled world-atlas topology (public/world-110m.json) folds France's overseas
departments (French Guiana, Guadeloupe, Martinique, Réunion, Mayotte) into the
single "France" feature (numeric id 250). On the map they therefore render with
metropolitan France's data and label. This script reclassifies France's polygons
by location and promotes each overseas department to its own feature with the
correct ISO numeric id, so it joins to its own data row.

  python scripts/fix_map_territories.py            # dry run: print classification
  python scripts/fix_map_territories.py --apply     # rewrite public/world-110m.json
"""
import json
import sys
from pathlib import Path

WORLD = Path(__file__).resolve().parent.parent / "public" / "world-110m.json"

# Overseas departments folded into France's polygon, with approx centroids and
# their ISO 3166-1 numeric codes (which our data joins on via ccn3).
TERRITORIES = {
    254: ("French Guiana", -53.0, 4.0),
    312: ("Guadeloupe", -61.5, 16.2),
    474: ("Martinique", -61.0, 14.6),
    638: ("Réunion", 55.5, -21.1),
    175: ("Mayotte", 45.1, -12.8),
}


def main():
    apply = "--apply" in sys.argv
    w = json.loads(WORLD.read_text(encoding="utf-8"))
    tr = w["transform"]
    sx, sy = tr["scale"]
    tx, ty = tr["translate"]
    arcs = w["arcs"]

    def first_point(arc_idx):
        if arc_idx < 0:
            arc_idx = ~arc_idx
        x, y = arcs[arc_idx][0][0], arcs[arc_idx][0][1]
        return x * sx + tx, y * sy + ty

    geoms = w["objects"]["countries"]["geometries"]
    france = next(g for g in geoms if str(g.get("id")) == "250")
    assert france["type"] == "MultiPolygon", france["type"]

    metro_polys = []          # stays in France (250)
    territory_polys = {}      # id -> [polygons]
    print(f"France has {len(france['arcs'])} polygons:")
    for i, poly in enumerate(france["arcs"]):
        lon, lat = first_point(poly[0][0])
        # Metropolitan France + Corsica box.
        if 41.0 <= lat <= 52.0 and -6.0 <= lon <= 11.0:
            metro_polys.append(poly)
            label = "metropolitan France (keep)"
        else:
            # nearest overseas department by centroid distance
            code = min(TERRITORIES, key=lambda c: (lon - TERRITORIES[c][1]) ** 2 + (lat - TERRITORIES[c][2]) ** 2)
            territory_polys.setdefault(code, []).append(poly)
            label = f"-> {TERRITORIES[code][0]} ({code})"
        print(f"  poly {i}: ({lon:7.2f}, {lat:6.2f})  {label}")

    print(f"\nKeep {len(metro_polys)} polygon(s) as France; "
          f"promote {sum(len(v) for v in territory_polys.values())} into "
          f"{len(territory_polys)} territory feature(s): "
          + ", ".join(f"{TERRITORIES[c][0]}({c})" for c in territory_polys))

    if not apply:
        print("\nDry run — re-run with --apply to rewrite the topology.")
        return

    france["arcs"] = metro_polys
    for code, polys in territory_polys.items():
        geoms.append({"type": "MultiPolygon", "id": str(code),
                      "arcs": polys, "properties": {"name": TERRITORIES[code][0]}})
    WORLD.write_text(json.dumps(w, separators=(",", ":")), encoding="utf-8")
    print(f"\nApplied. France now has {len(metro_polys)} polygon(s); "
          f"added {len(territory_polys)} territory feature(s). Wrote {WORLD.name}.")


if __name__ == "__main__":
    main()
