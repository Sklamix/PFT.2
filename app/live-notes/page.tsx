'use client'

import type { SealedLiveQuery } from '@neon/realtime/client'
import { createRealtimeClient } from '@neon/realtime/client'
import { RealtimeProvider, useLiveQuery } from '@neon/realtime-react'
import { useCallback, useEffect, useState } from 'react'

import type { LiveNote } from '@/lib/realtime/server'

async function fetchSealedNotes(): Promise<SealedLiveQuery<LiveNote>> {
  const res = await fetch('/api/realtime/notes/seal')
  if (!res.ok) throw new Error(`Could not fetch the sealed query (${res.status})`)
  return (await res.json()) as SealedLiveQuery<LiveNote>
}

async function addNote(body: string) {
  const res = await fetch('/api/realtime/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (!res.ok) throw new Error(`Insert failed (${res.status})`)
  const result = (await res.json()) as { kind: string; txid: string }
  return result.txid
}

function NotesLive({ sealedQuery }: { sealedQuery: SealedLiveQuery<LiveNote> }) {
  const [draft, setDraft] = useState('')
  const [lastTxid, setLastTxid] = useState<string>()

  // Renewals must seal the SAME query, so refresh with the exact same callback shape.
  const refreshQuery = useCallback(() => fetchSealedNotes(), [])
  const { data, status, error, utils } = useLiveQuery(sealedQuery, { refreshQuery })

  useEffect(() => {
    return utils.onUpdate((update) => {
      if (update.type === 'changes') {
        console.log(`live_notes: ${update.changes.length} change(s) from txids ${update.batch.txids.join(', ')}`)
      }
    })
  }, [utils])

  if (status === 'error') {
    return <p role="alert">Live updates stopped: {error.message}</p>
  }
  if (data === undefined) {
    return <p>Loading live notes…</p>
  }

  return (
    <section>
      {status === 'stale' && <p role="status">Renewing live query — rows may be out of date…</p>}
      <p role="status">{status === 'live' ? 'Up to date' : status}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const body = draft.trim()
          if (!body) return
          setDraft('')
          addNote(body).then((txid) => setLastTxid(txid)).catch(() => setLastTxid(undefined))
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={280} placeholder="Type a note…" />
        <button type="submit">Add</button>
      </form>
      {lastTxid && <p>Committed transaction: {lastTxid}</p>}
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>body</th>
            <th>created_at</th>
          </tr>
        </thead>
        <tbody>
          {data.map((note) => (
            <tr key={note.id}>
              <td>{note.id}</td>
              <td>{note.body}</td>
              <td>{new Date(note.created_at).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Notes() {
  const [sealed, setSealed] = useState<SealedLiveQuery<LiveNote>>()

  useEffect(() => {
    let cancelled = false
    fetchSealedNotes().then(
      (sealedQuery) => {
        if (!cancelled) setSealed(sealedQuery)
      },
      () => {
        /* retry on the next render cycle; the page shows the loading state */
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  if (!sealed) return <p>Loading live notes…</p>
  return <NotesLive sealedQuery={sealed} />
}

export default function LiveNotesPage() {
  // One client per app; created here (not at module level) so it never runs on the server.
  const [client] = useState(() =>
    createRealtimeClient({
      url: process.env.NEXT_PUBLIC_NEON_REALTIME_URL!,
    }),
  )

  return (
    <main>
      <h1>Live notes (Neon Realtime)</h1>
      <RealtimeProvider client={client}>
        <Notes />
      </RealtimeProvider>
    </main>
  )
}
