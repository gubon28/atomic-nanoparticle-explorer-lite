/**
 * Plain-text XYZ export, generated locally (no server round-trip).
 * Format: element count line, comment line, then "Symbol x y z" per atom.
 */

import type { LiteResult } from './types'

export function toXyz(result: LiteResult): string {
  const n = result.analysis.nAtoms
  const symbol = result.element.symbol
  const lines: string[] = []
  lines.push(String(n))
  lines.push(
    `# ${symbol} ${result.morphology.label} · ${result.request.diameterNm.toFixed(2)} nm · ` +
      `${n} atoms · lattice a=${result.element.latticeConstantA.toFixed(4)} Angstrom · ` +
      'ideal unrelaxed FCC model generated locally in the browser',
  )
  for (let i = 0; i < n; i += 1) {
    const x = result.positionsA[i * 3]
    const y = result.positionsA[i * 3 + 1]
    const z = result.positionsA[i * 3 + 2]
    lines.push(`${symbol} ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`)
  }
  return `${lines.join('\n')}\n`
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
