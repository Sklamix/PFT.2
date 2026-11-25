'use client'

import type { ReactElement } from 'react'

/**
 * Minimal markdown renderer for support messages.
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
 *
 * `tone` is not decorative: AI replies get cyan accents (labels, bold, callouts,
 * code, table heads) so the important line is findable at a glance, while a
 * human's own reply stays calm.
 */

export type MessageTone = 'neutral' | 'ai' | 'staff'

type ToneStyle = {
  label: string
  callout: string
  strong: string
  code: string
  tableHead: string
  tableHeadRow: string
}

const TONES: Record<MessageTone, ToneStyle> = {
  neutral: {
    label: 'text-muted-foreground',
    callout: 'border-warning/60 bg-warning/5',
    strong: 'font-semibold text-foreground',
    code: 'text-foreground',
    tableHead: 'text-muted-foreground',
    tableHeadRow: '',
  },
  ai: {
    label: 'text-highlight',
    callout: 'border-highlight/60 bg-highlight/10',
    strong: 'font-semibold text-highlight',
    code: 'text-highlight',
    tableHead: 'text-highlight',
    tableHeadRow: 'bg-highlight/5',
  },
  staff: {
    label: 'text-muted-foreground',
    callout: 'border-warning/50 bg-warning/5',
    strong: 'font-semibold text-foreground',
    code: 'text-foreground',
    tableHead: 'text-muted-foreground',
    tableHeadRow: '',
  },
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

function renderInline(text: string, tone: ToneStyle): ReactElement {
  // Split on **bold** and `code` spans; interleave text.
  const parts: (string | ReactElement)[] = []
  const regex = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(last, match.index)
    if (before) parts.push(before)
    if (match[1] != null) parts.push(<strong key={key++} className={tone.strong}>{match[1]}</strong>)
    else parts.push(<code key={key++} className={`rounded bg-black/25 px-1 py-0.5 font-mono text-[0.92em] ${tone.code}`}>{match[2]}</code>)
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

function renderTable(lines: string[], start: number, tone: ToneStyle): { element: ReactElement; next: number } {
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
          <tr className={`border-b border-border ${tone.tableHeadRow}`}>
            {headers.map((h, i) => (
              <th key={i} className={`p-2 text-left font-mono uppercase text-[10px] ${tone.tableHead}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-border/50 last:border-0">
              {row.map((cell, i) => (
                <td key={i} className="p-2 align-top">{renderInline(cell, tone)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    next: index,
  }
}

export function MessageBody({ text, tone = 'neutral' }: { text: string; tone?: MessageTone }): ReactElement {
  const style = TONES[tone] ?? TONES.neutral
  const normalized = text.replace(/\r\n/g, '\n')
  const rawLines = splitLines(normalized)
  const elements: ReactElement[] = []
  let i = 0

  while (i < rawLines.length) {
    const line = rawLines[i]

    // Section labels (## or ###).
    if (/^###? /.test(line)) {
      elements.push(
        <span key={elements.length} className={`block pb-1 pt-2 font-mono text-[10px] uppercase tracking-widest first:pt-0 ${style.label}`}>
          {line.replace(/^###? /, '')}
        </span>,
      )
      i += 1
      continue
    }

    // Pipe table.
    if (line.includes('|') && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1])) {
      const { element, next } = renderTable(rawLines, i, style)
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
        <blockquote key={elements.length} className={`my-2 border-l-2 px-3 py-2 ${style.callout}`}>
          <p className="text-foreground">{quoteLines.map((l, idx) => (<span key={idx}>{renderInline(l, style)}<br /></span>))}</p>
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
        <Tag key={elements.length} className={`my-1.5 ml-3 space-y-0.5 pl-2 ${isOrdered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, style)}</li>
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
        {renderInline(line, style)}
      </p>,
    )
    i += 1
  }

  if (elements.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  return <div className="space-y-0.5" data-tone={tone}>{elements}</div>
}
