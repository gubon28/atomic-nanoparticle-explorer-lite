import { useCallback, useEffect, useState, type RefObject } from 'react'

/**
 * Real fullscreen for the viewer stage (Phase 2.2).
 *
 * Handles the prefixed WebKit API as well as the standard one, keeps the button
 * state in sync with the browser (including Esc), and reports a visible message
 * when the browser refuses or does not support the request instead of failing
 * silently.
 */

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
  webkitRequestFullScreen?: () => Promise<void> | void
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
  webkitCancelFullScreen?: () => Promise<void> | void
}

export interface FullscreenApi {
  isFullscreen: boolean
  supported: boolean
  toggle: () => Promise<void>
  message: string | null
  dismiss: () => void
}

function fullscreenNode(doc: FullscreenDocument | null): Element | null {
  if (!doc) return null
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

export function useFullscreen(target: RefObject<HTMLElement | null>): FullscreenApi {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const doc = typeof document === 'undefined' ? null : (document as FullscreenDocument)
  const supported = Boolean(
    doc &&
      (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) &&
      ((doc.documentElement as FullscreenElement).requestFullscreen ||
        (doc.documentElement as FullscreenElement).webkitRequestFullscreen),
  )

  useEffect(() => {
    if (!doc) return
    const sync = () => setIsFullscreen(Boolean(fullscreenNode(doc)))
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [doc])

  const toggle = useCallback(async () => {
    const node = target.current as FullscreenElement | null
    if (!doc || !node) return
    try {
      if (fullscreenNode(doc)) {
        const exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc) ?? doc.webkitCancelFullScreen?.bind(doc)
        if (!exit) {
          setMessage('This browser exposes no way to leave fullscreen — press Esc.')
          return
        }
        await exit()
        setMessage(null)
        return
      }
      const request =
        node.requestFullscreen?.bind(node) ?? node.webkitRequestFullscreen?.bind(node) ?? node.webkitRequestFullScreen?.bind(node)
      if (!request) {
        setMessage('Fullscreen is not available in this browser — the normal view is unchanged.')
        return
      }
      await request()
      setMessage(null)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setMessage(`The browser refused fullscreen (${detail}). Staying in the normal view.`)
    }
  }, [doc, target])

  return { isFullscreen, supported, toggle, message, dismiss: () => setMessage(null) }
}
