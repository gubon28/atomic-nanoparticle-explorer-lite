"""Freeze reference values from the Full (Python) engine for the Lite test-suite.

This script is a *validation tool*: it imports the reference implementation
read-only and writes one JSON file that the TypeScript test-suite compares the
browser-only Lite engine against.  No source code of the Full engine is copied
into this repository — only its numeric output.

Usage (needs an interpreter with numpy/scipy/ase, i.e. the Full project's venv):

    FULL_BACKEND=C:/Users/<user>/nanoparticle-explorer/backend \
        <full-venv-python> tools/make_fixtures.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Path of the reference implementation's backend package.  Set FULL_BACKEND when
# regenerating the fixtures, e.g.:
#   FULL_BACKEND=/path/to/full-edition/backend <python-with-numpy-scipy-ase> tools/make_fixtures.py
FULL_BACKEND = Path(os.environ.get("FULL_BACKEND", "full-edition/backend"))
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "full-engine.json"

sys.path.insert(0, str(FULL_BACKEND))

from app.analysis import analyze  # noqa: E402
from app.elements import element_payload  # noqa: E402
from app.generator import build_nanoparticle  # noqa: E402

# (id, element, morphology, diameter_nm, custom_weights, lattice_align, boundary_inclusion)
CASES: list[tuple[str, str, str, float, dict | None, bool, str]] = [
    ("au-cube-2.0", "Au", "cube", 2.0, None, False, "center"),
    ("au-octahedron-2.5", "Au", "octahedron", 2.5, None, False, "center"),
    ("au-rhombic_dodecahedron-2.5", "Au", "rhombic_dodecahedron", 2.5, None, False, "center"),
    ("au-truncated_octahedron-2.0", "Au", "truncated_octahedron", 2.0, None, False, "center"),
    ("au-cuboctahedron-2.5", "Au", "cuboctahedron", 2.5, None, False, "center"),
    ("au-custom-100-110-111-2.5", "Au", "custom", 2.5, {"100": 1.0, "110": 1.0, "111": 1.5}, False, "center"),
    ("ag-cube-2.0", "Ag", "cube", 2.0, None, False, "center"),
    ("pt-truncated_octahedron-1.8", "Pt", "truncated_octahedron", 1.8, None, False, "center"),
    ("pd-octahedron-2.0", "Pd", "octahedron", 2.0, None, False, "center"),
    ("cu-cube-1.6", "Cu", "cube", 1.6, None, False, "center"),
    ("au-truncated_octahedron-2.0-aligned", "Au", "truncated_octahedron", 2.0, None, True, "center"),
    ("au-cube-2.0-shell", "Au", "cube", 2.0, None, False, "shell"),
]


def main() -> int:
    fixtures = []
    total_atoms = 0
    for case_id, element, morphology, diameter, custom, align, inclusion in CASES:
        a = float(element_payload(element)["lattice_constant_a"])
        # families in ascending key order — the Lite engine sorts the same way, so
        # plane indices (and every facet index derived from them) line up
        ordered_custom = dict(sorted(custom.items())) if custom else None
        build = build_nanoparticle(
            symbol=element,
            a=a,
            morphology=morphology,
            diameter_nm=diameter,
            boundary_inclusion=inclusion,
            lattice_align=align,
            custom_weights=ordered_custom,
        )
        analysis = analyze(build)
        positions = [[round(float(v), 6) for v in row] for row in build.positions_a]
        total_atoms += len(positions)
        fixtures.append(
            {
                "id": case_id,
                "request": {
                    "element": element,
                    "morphology": morphology,
                    "diameterNm": diameter,
                    "customWeights": ordered_custom,
                    "latticeAlign": align,
                    "boundaryInclusion": inclusion,
                },
                "weights": {fam: float(w) for fam, w in build.weights.items()},
                "nAtoms": int(len(positions)),
                "positionsA": positions,
                "coordination": [int(v) for v in analysis.cn],
                "siteClass": [int(v) for v in analysis.site_class],
                "facetPlaneIndex": [int(v) for v in analysis.facet_plane_index],
                "facetId": [int(v) for v in analysis.facet_id],
                "planes": [
                    {
                        "index": int(p.index),
                        "family": p.family,
                        "miller": [int(v) for v in p.miller],
                        "distanceA": float(p.distance_a),
                        "spacingA": float(p.spacing_a),
                    }
                    for p in build.planes
                ],
                "facets": [
                    {
                        "index": int(f.index),
                        "planeIndex": int(f.plane_index),
                        "family": f.family,
                        "miller": [int(v) for v in f.miller],
                        "distanceA": float(f.distance_a),
                        "areaA2": float(f.area_a2),
                    }
                    for f in build.shape.facets
                ],
                "volumeA3": float(build.shape.volume_a3),
                "surfaceAreaA2": float(build.shape.surface_area_a2),
                "maxExtentA": float(build.shape.max_extent_a),
                "requestedDiameterNm": float(build.requested_diameter_nm),
                "achievedDiameterNm": float(build.achieved_diameter_nm),
                "cutoffA": float(1.2 * a / (2 ** 0.5)),
                "nearestNeighbourA": float(a / (2 ** 0.5)),
                "classCounts": {
                    "bulk": int((analysis.site_class == 0).sum()),
                    "facet": int((analysis.site_class == 1).sum()),
                    "edge": int((analysis.site_class == 2).sum()),
                    "corner": int((analysis.site_class == 3).sum()),
                    "surface_other": int((analysis.site_class == 4).sum()),
                },
                "surfaceAtoms": int((analysis.site_class != 0).sum()),
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generator": "Full Python engine (reference implementation), frozen for Lite cross-validation",
        "cases": fixtures,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} · {len(fixtures)} cases · {total_atoms} reference atoms · {OUT.stat().st_size / 1024:.1f} KB")
    for fixture in fixtures:
        print(
            f"  {fixture['id']:<38} atoms={fixture['nAtoms']:>5}  facets={len(fixture['facets']):>2}  "
            f"V={fixture['volumeA3']:.3f}  A={fixture['surfaceAreaA2']:.3f}  "
            f"surface={fixture['surfaceAtoms']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
