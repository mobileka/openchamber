/**
 * Viewport Store — per-session scroll anchors, streaming state, memory.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import { getRuntimeKey } from "@/lib/runtime-switch"

/** The row at the viewport top, for returning to a session where it was left. */
type ViewportRestoreAnchor = {
  messageId: string
  offsetTop: number
}

export type SessionMemoryState = {
  viewportAnchor: number
  /** Last known scrollbar pixel state — saved on every scroll event. */
  scrollPosition?: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  }
  /** Row the reader was on when the position was last saved. */
  restoreAnchor?: ViewportRestoreAnchor | null
  /** True when the reader was at the end; re-entry then follows the end. */
  restoreAtEnd?: boolean
  isStreaming: boolean
  streamStartTime?: number
  lastAccessedAt: number
  backgroundMessageCount: number
  loadedTurnCount?: number
  hasMoreAbove?: boolean
  hasMoreTurnsAbove?: boolean
  historyLoading?: boolean
  historyComplete?: boolean
  historyLimit?: number
  totalAvailableMessages?: number
  streamingCooldownUntil?: number
  isZombie?: boolean
  lastUserMessageAt?: number
}

export type ViewportState = {
  sessionMemoryState: Map<string, SessionMemoryState>
  isSyncing: boolean

  updateViewportAnchor: (
    sessionId: string,
    anchor: number,
    scrollPosition?: SessionMemoryState['scrollPosition'],
    restore?: { anchor: ViewportRestoreAnchor | null; atEnd: boolean },
  ) => void
}

export const viewportSessionKey = (sessionId: string, runtimeKey = getRuntimeKey()): string => `${runtimeKey}\n${sessionId}`

export const getViewportSessionMemory = (sessionId: string): SessionMemoryState | undefined => {
  const state = useViewportStore.getState()
  return state.sessionMemoryState.get(viewportSessionKey(sessionId)) ?? state.sessionMemoryState.get(sessionId)
}

export const useViewportStore = create<ViewportState>()((set) => ({
  sessionMemoryState: new Map(),
  isSyncing: false,

  updateViewportAnchor: (sessionId, anchor, scrollPosition, restore) =>
    set((s) => {
      const map = new Map(s.sessionMemoryState)
      const key = viewportSessionKey(sessionId)
      const existing = map.get(key) ?? map.get(sessionId) ?? {
        viewportAnchor: 0,
        isStreaming: false,
        lastAccessedAt: Date.now(),
        backgroundMessageCount: 0,
      }
      const next: SessionMemoryState = {
        ...existing,
        viewportAnchor: anchor,
        lastAccessedAt: Date.now(),
      }
      if (scrollPosition) {
        next.scrollPosition = scrollPosition
      }
      if (restore) {
        next.restoreAnchor = restore.anchor
        next.restoreAtEnd = restore.atEnd
      }
      map.set(key, next)
      return { sessionMemoryState: map }
    }),
}))
