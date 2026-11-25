'use client'

import type { ReactElement } from 'react'

/**
 * Minimal markdown renderer for AI support messages.
 *
 * Supported subset (and nothing else):
 *  - blank lines → paragraphs
 *  - `- ` / `* ` list items → <ul><li>
 *  - `1. ` numbered items → <ol><li>
 *  - **bold** → <strong>
 *  - `code` → <code>
 *  - lines starting with `> ` → callout (left border, tinted background)
 *  - `## ` / `### ` → section label (mono uppercase, 10px)
 *  - pipe tables → <table>
 *
 * Everything else is rendered as plain text.
 */

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

function renderInline(text: string): ReactElement {
  // Split on **bold** and `code` spans; interleave text.
  const parts: (string | ReactElement)[] = []
  const regex = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(last, match.index)
    if (before) parts.push(before)
    if (match[1] != null) parts.push(<strong key={key++}>{match[1]}</strong>)
    else parts.push(<code key={key++}>{match[2]}</code>)
    last = regex.lastIndex
  }
  const tail = text.slice(last)
  if (tail) parts.push(tail)
  return <>{parts}</>
}

function isTableSeparator(line: string): boolean {
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').trim().split('|').map((c) => c.trim())
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
}

function tableHeaders(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').trim().split('|').map((c) => c.trim())
}

function renderTable(lines: string[], start: number): { element: ReactElement; next: number } {
  const headers = tableHeaders(lines[start])
  let index = start + 1
  // Skip separator row.
  if (index < lines.length && isTableSeparator(lines[index])) index += 1
  const rows: string[][] = []
  while (index < lines.length && lines[index].includes('|') && lines[index].trim().length > 0) {
    rows.push(tableHeaders(lines[index]))
    index += 1
  }
  return {
    element: (
      <table className="w-full text-xs" key="table">
        <thead>
          <tr className="border-b border-border">
            {headers.map((h, i) => (
              <th key={i} className="p-2 text-left font-mono uppercase text-[10px] text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-border/50 last:border-0">
              {row.map((cell, i) => (
                <td key={i} className="p-2 align-top">{renderInline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    next: index,
  }
}

export function MessageBody({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'ai' | 'staff' }): ReactElement {
  const normalized = text.replace(/\r\n/g, '\n')
  const rawLines = splitLines(normalized)
  const elements: ReactElement[] = []
  let i = 0

  while (i < rawLines.length) {
    const line = rawLines[i]

    // Section labels (## or ###).
    if (/^###? /.test(line)) {
      elements.push(
        <span key={elements.length} className="block pb-1 pt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground first:pt-0">
          {line.replace(/^###? /, '')}
        </span>,
      )
      i += 1
      continue
    }

    // Pipe table.
    if (line.includes('|') && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1]) && elements.length >= 0) {
      const { element, next } = renderTable(rawLines, i)
      elements.push(element)
      i = next
      continue
    }

    // Callout block (blockquote).
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < rawLines.length && rawLines[i].startsWith('> ')) {
        quoteLines.push(rawLines[i].slice(2))
        i += 1
      }
      elements.push(
        <blockquote key={elements.length} className="my-2 border-l-2 border-warning/60 bg-warning/5 px-3 py-2">
          <p className="mb-0.5 font-mono text-[10px] uppercase tracking-widest text-warning">Важливо</p>
          <p className="text-foreground">{quoteLines.map((l, idx) => (<span key={idx}>{renderInline(l)}<br /></span>))}</p>
        </blockquote>,
      )
      continue
    }

    // List items.
    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const isOrdered = /^\d+\. /.test(line)
      const Tag = isOrdered ? 'ol' : 'ul'
      const items: string[] = []
      while (i < rawLines.length && (/^[-*] /.test(rawLines[i]) || /^\d+\. /.test(rawLines[i]))) {
        items.push(rawLines[i].replace(/^[-*] /, '').replace(/^\d+\. /, '').trim())
        i += 1
      }
      elements.push(
        <Tag key={elements.length} className="my-1.5 ml-3 list-disc space-y-0.5 pl-2">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </Tag>,
      )
      continue
    }

    // Blank line → paragraph separator (handled implicitly by block elements).
    if (line.trim() === '') {
      i += 1
      continue
    }

    // Paragraph.
    elements.push(
      <p key={elements.length} className="my-0.5 break-words leading-relaxed">
        {renderInline(line)}
      </p>,
    )
    i += 1
  }

  if (elements.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  return <div className="space-y-0.5" data-tone={tone}>{elements}</div>
}
