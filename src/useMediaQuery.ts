import { useEffect, useState } from 'react'

/** The single breakpoint that separates the phone/tablet layout from the desktop shell. */
export const MOBILE_QUERY = '(max-width: 1024px)'

/**
 * Reactive media query.
 *
 * The mobile viewer is a different *structure* (compact toolbar, no in-canvas
 * legend, panels below the stage), not just a restyle, so the component needs the
 * flag in JavaScript as well as in CSS.  CSS remains the source of truth for the
 * layout itself.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const update = () => setMatches(mql.matches)
    update()
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }
    // Safari < 14
    const legacy = mql as MediaQueryList & { addListener?: (cb: () => void) => void; removeListener?: (cb: () => void) => void }
    legacy.addListener?.(update)
    return () => legacy.removeListener?.(update)
  }, [query])

  return matches
}

/**
 * Vertical space (CSS px) the compact mobile toolbar and the HUD occupy inside the
 * stage.  Reserved symmetrically around the particle so the framing is centred in
 * the unobstructed band the user actually sees.
 */
export const MOBILE_STAGE_INSET = 56
