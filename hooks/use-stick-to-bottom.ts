'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type UseStickToBottomOptions = {
  /** Offset threshold (px) for counting as "at bottom". */
  threshold?: number
  /** How many items are currently rendered; drives the unread counter. */
  count?: number
}

/**
 * Keeps a scroll container pinned to the bottom while the reader is at the
 * bottom, and counts what arrived while they were not.
 *
 * `unread` is the difference between the current item count and the count the
 * reader last saw *at the bottom* — not a tick counter, so a poll that returns
 * nothing new never inflates it.
 */
export function useStickToBottom<T extends HTMLElement>(
  dep: unknown,
  options: UseStickToBottomOptions = {},
): {
  ref: React.RefObject<T | null>
  atBottom: boolean
  unread: number
  scrollToBottom: (behavior?: ScrollBehavior) => void
  resetUnread: () => void
} {
  const { threshold = 48, count = 0 } = options
  const ref = useRef<T | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [unread, setUnread] = useState(0)
  const atBottomRef = useRef(true)
  const countRef = useRef(count)
  /** Item count at the moment the reader last saw the bottom. */
  const seenRef = useRef(0)

  useEffect(() => {
    countRef.current = count
  }, [count])

  const resetUnread = useCallback(() => {
    seenRef.current = countRef.current
    setUnread(0)
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    atBottomRef.current = true
    setAtBottom(true)
    seenRef.current = countRef.current
    setUnread(0)
  }, [])

  // The list changed: follow it when the reader is at the bottom, otherwise
  // report how much is waiting below.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (count === 0) {
      // Fresh conversation or a ticket switch — nothing to catch up on.
      seenRef.current = 0
      atBottomRef.current = true
      setAtBottom(true)
      setUnread(0)
      return
    }
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      seenRef.current = count
      setUnread(0)
      return
    }
    const delta = count - seenRef.current
    setUnread(delta > 0 ? delta : 0)
  }, [dep, count])

  // Scrolling back to the bottom clears the counter.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const handler = () => {
      const at = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
      atBottomRef.current = at
      setAtBottom(at)
      if (at) {
        seenRef.current = countRef.current
        setUnread(0)
      }
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [dep, threshold])

  return { ref, atBottom, unread, scrollToBottom, resetUnread }
}
