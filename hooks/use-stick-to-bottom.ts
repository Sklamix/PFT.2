'use client'

import { useEffect, useRef, useState } from 'react'

type UseStickToBottomOptions = {
  /** Offset threshold (px) for counting as "at bottom". */
  threshold?: number
}

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
  const { threshold = 48 } = options
  const ref = useRef<T | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [unread, setUnread] = useState(0)
  const unreadRef = useRef(0)
  const atBottomRef = useRef(true)

  function updateBottom() {
    const el = ref.current
    if (!el) return true
    const at = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
    atBottomRef.current = at
    setAtBottom(at)
    return at
  }

  function bumpUnread() {
    unreadRef.current += 1
    setUnread(unreadRef.current)
  }

  function resetUnread() {
    unreadRef.current = 0
    setUnread(0)
  }

  function scrollToBottom(behavior: ScrollBehavior = 'auto') {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    resetUnread()
  }

  // When dep changes (e.g. ticket selected), snap to bottom if we were there.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
    else bumpUnread()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep])

  // Reset unread when element mounts/remounts.
  useEffect(() => {
    setAtBottom(true)
    resetUnread()
    atBottomRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current])

  // Scroll listener.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const handler = () => {
      updateBottom()
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep])

  return { ref, atBottom, unread, scrollToBottom, resetUnread }
}
