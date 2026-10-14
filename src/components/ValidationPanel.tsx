import { useMemo } from 'react'
import { runSelfChecks } from '../validate'
import type { LiteResult } from '../types'

/**
 * Live scientific self-checks plus a summary of the reference cross-validation.
 *
 * The checks below are recomputed from the current structure in the browser.
 * The same engine is additionally validated in the test-suite against the frozen
 * output of the reference implementation (`tests/fixtures/full-engine.json`):
 * 12 cases × atomic coordinates, coordination numbers, site classes, facet
 * assignments, plane geometry, volumes, areas and terrace counts.
 */
export default function ValidationPanel({ result }: { result: LiteResult | null }) {
  const checks = useMemo(() => (result ? runSelfChecks(result) : []), [result])
  const failed = checks.filter((check) => !check.passed)

  return (
    <section className="panel">
      <h2>
        Scientific checks <span className="ko">검증</span>
      </h2>
      {result ? (
        <>
          <div className={failed.length === 0 ? 'check-summary ok' : 'check-summary bad'}>
            {failed.length === 0
              ? `all ${checks.length} live checks passed on this particle`
              : `${failed.length} of ${checks.length} checks failed`}
          </div>
          <ul className="checks">
            {checks.map((check) => (
              <li key={check.id} className={check.passed ? 'pass' : 'fail'}>
                <span className="check-mark">{check.passed ? '✓' : '✗'}</span>
                <span className="check-body">
                  <span className="check-name">{check.name}</span>
                  <span className="check-detail">{check.detail}</span>
                  <span className="check-tol">tolerance: {check.tolerance}</span>
                </span>
              </li>
            ))}
          </ul>
          <details className="details">
            <summary>cross-validation against the reference engine</summary>
            <ul className="facts">
              <li>12 frozen cases (5 metals, 5 presets, custom mix, aligned and shell variants), 4,468 reference atoms.</li>
              <li>Atomic coordinate sets compared atom-by-atom, tolerance 1e-9 Å.</li>
              <li>Coordination numbers, site classes and facet assignments compared per atom, exact integers.</li>
              <li>Volume and surface area compared with 1e-12 relative tolerance.</li>
              <li>Facet areas compared per facet (family + Miller index), 1e-12 relative tolerance.</li>
              <li>The fixtures are frozen by `tools/make_fixtures.py`, which reads the reference engine read-only.</li>
            </ul>
          </details>
        </>
      ) : (
        <p className="hint">Waiting for a particle…</p>
      )}
    </section>
  )
}
