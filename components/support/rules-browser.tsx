'use client'

import { useMemo, useState } from 'react'
import rulebook from '@/lib/rules/rulebook.generated.json'
import { MessageBody } from '@/components/support/chat/message-body'
import { RULES_EFFECTIVE_DATE } from '@/lib/rules/version'
import { cn } from '@/lib/utils'

type Section = { num: number; title: string; markdown: string; keywords: string[] }

type Props = { onInsert?: (text: string) => void }

/** Category chips → rulebook section numbers (they set the search query). */
export const RULE_CATEGORY_NUMBERS: Record<string, number[]> = {
  Drawdown: [5, 6],
  Payouts: [17],
  KYC: [21],
  News: [9],
  Prohibited: [14],
  Fees: [18],
  Breach: [19],
}

/**
 * Rules browser: static, searchable, collapsed sections. Rules data is
 * generated at build time from the rulebook markdown (scripts/build-rulebook.ts),
 * so the component is fully offline in the APK.
 */
export function RulesBrowser({ onInsert }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number[]>([])

  const sections = useMemo(() => rulebook.sections as Section[], [])
  const filtered = useMemo(() => {
    const numbers = category ? RULE_CATEGORY_NUMBERS[category] : null
    const needle = query.trim().toLowerCase()
    return sections.filter((section) => {
      if (numbers && !numbers.includes(section.num)) return false
      if (!needle) return true
      return `${section.title} ${section.markdown} ${section.keywords.join(' ')}`.toLowerCase().includes(needle)
    })
  }, [sections, query, category])

  const toggle = (num: number) =>
    setExpanded((current) => (current.includes(num) ? current.filter((n) => n !== num) : [...current, num]))

  const insertText = (section: Section) => onInsert?.(`§${section.num} ${section.title}\n${section.markdown}`)

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Rules v{rulebook.version} · effective {rulebook.effective ?? RULES_EFFECTIVE_DATE}
      </p>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search rules…"
        className="h-8 min-w-0 rounded-md border border-border bg-background/70 px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring"
        aria-label="Search rules"
      />
      <div className="flex flex-wrap gap-1.5">
        {Object.keys(RULE_CATEGORY_NUMBERS).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setCategory((current) => (current === item ? null : item))}
            className={cn(
              'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              category === item ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground',
            )}
          >
            {item}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No rules match the current search.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {filtered.map((section) => {
            const open = expanded.includes(section.num)
            return (
              <li key={section.num}>
                <button
                  type="button"
                  onClick={() => toggle(section.num)}
                  aria-expanded={open}
                  className="flex w-full items-start justify-between gap-2 rounded-md border border-border/70 bg-secondary/30 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <span className="text-xs font-semibold text-foreground">
                    §{section.num} {section.title}
                  </span>
                  <svg
                    className={cn('mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform', open ? 'rotate-180' : '')}
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path d="M2 4 L6 8 L10 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                {open ? (
                  <div className="mt-1.5 border-l-2 border-border/70 pl-2.5">
                    <MessageBody text={section.markdown} />
                    <button
                      type="button"
                      onClick={() => insertText(section)}
                      className="mt-2 rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
                    >
                      Insert into reply
                    </button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
