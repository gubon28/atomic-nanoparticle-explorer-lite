# Atomic Nanoparticle Explorer · Lite

Browser-only crystallographic **FCC nanoparticle generator** with a 3D atomistic viewer.
Builds ideal metal nanoparticles from crystallographic half-spaces and computes the
atomic structure, coordination numbers and surface classification **entirely in the
browser** — no backend server, no Python, no upload, no external API.

**Live:** https://gubon28.github.io/atomic-nanoparticle-explorer-lite/

## What it does

- **Metals:** Au, Ag, Pt, Pd, Cu (room-temperature lattice constants, FCC / Fm-3m / cF4).
- **Shapes:** cube `{100}`, octahedron `{111}`, rhombic dodecahedron `{110}`,
  truncated octahedron, cuboctahedron, and a free mix of `{100}/{110}/{111}` with
  draggable relative plane distances.
- **Real atom positions:** the FCC lattice is clipped by the half-spaces; the diameter,
  optional lattice-plane alignment and the "include the outer atomic shell" option are
  handled exactly as in the reference implementation.
- **Analysis:** coordination numbers (radial cut-off `1.2 · a/√2`), bulk/terrace/edge/
  corner classification relative to the outermost occupied atomic layer, facet areas,
  volume, surface area and specific surface area.
- **3D viewer:** single-draw-call instanced rendering, five colour modes, facet planes
  with Miller-index labels, direction axes, wireframe, orthographic/perspective cameras,
  PNG screenshot and XYZ export.

## Scope (Lite edition)

Included are the basic generation and visualisation features. **Not** included —
these belong to the full desktop edition: high-index facets such as `{210}`–`{321}`
or user-defined `(hkl)`, concave morphologies, nanorods / nanoplates / bipyramids,
multiply twinned (decahedral / icosahedral) clusters, atomic measurement, atomic-column
projection and the missing-bond surface-site analysis.

## How it works (no backend)

1. **Planes** — each family expands into all symmetry-equivalent half-spaces
   `n̂·r ≤ d` (6 for `{100}`, 12 for `{110}`, 8 for `{111}`).
2. **Polyhedron** — every vertex of a bounded half-space intersection is the solution of
   a triple of plane equations, so all C(n,3) triples (≤ 364 here) are solved and the
   feasible ones kept. No convex-hull library or WASM is needed, and the vertices come out
   exact in double precision. Facet areas use Newell's method, the volume follows from
   `V = Σ Aᵢdᵢ/3` (exact for a convex body containing the origin).
3. **Atoms** — the FCC lattice (conventional cell + 4-atom basis) is enumerated inside the
   bounding box and clipped by the half-spaces; the result is sorted deterministically,
   so the same request always gives the same coordinates.
4. **Coordination** — a uniform grid with an injective bucket key gives O(N) neighbour
   counting with the same cut-off as the reference engine.

## Validation

`npm test` (Vitest) runs **118 checks**:

- **First principles:** `a/√2` nearest-neighbour distance for all five metals, every atom
  on an FCC site (a/2 grid with even `i+j+k` parity), facet counts (6/8/12/14), facet
  normals vs Miller indices, closed-form volumes, determinism, the atom-budget guard.
- **Cross-validation** against the reference (Python) implementation, frozen in
  `tests/fixtures/full-engine.json` (12 cases, 4,468 atoms): the **actual atomic coordinate
  sets** are compared atom-by-atom (1e-9 Å), plus coordination numbers, site classes and
  facet assignments (exact integers), plane geometry, per-facet areas, volumes and surface
  areas (1e-12 relative).

The fixtures are produced by `tools/make_fixtures.py`, which imports the reference engine
read-only and writes only its numeric output — none of its source code is part of this
repository.

## Limits and honesty notes

- Ideal, **unrelaxed** models: atoms sit on perfect FCC sites. No relaxation,
  reconstruction, adsorbates, support or temperature.
- One browser thread, so a request is **refused** above **30,000 atoms** (≈ 9 nm for a
  truncated octahedron) instead of freezing the tab.
- Facet areas are continuous-geometry values while facet atom counts are discrete; they
  agree within one lattice spacing.
- The `{110}` surface is grooved, so some of its atoms are reported as "other surface"
  rather than `{110}` terrace atoms.

## Development

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # scientific validation (Vitest)
npm run typecheck
npm run build      # tsc --noEmit && vite build  ->  dist/
npm run preview    # serve dist/ locally
```

`vite.config.ts` sets `base: '/atomic-nanoparticle-explorer-lite/'` so the built assets
resolve correctly under the GitHub Pages project sub-path.

## Deployment

`.github/workflows/deploy.yml` installs, runs the scientific test-suite, builds and
publishes `dist/` to GitHub Pages on every push to `main`. GitHub Pages and Actions
minutes are free for public repositories — this project uses no paid service, no billing
and no external hosting.
