import type { ReactNode } from 'react'

export type LegalSection = {
  heading: string
  body: ReactNode
}

/**
 * Shared renderer for the public legal documents.
 *
 * Every document produced by this component is a DRAFT derived from the product's own
 * documented rules (docs/PFT-rulebook-v1.md) and the claims already published on the
 * marketing site. They have not been reviewed by external counsel — the banner below
 * says so on every page. Reviewing and replacing the text is a counsel task; this
 * component only guarantees the pages exist, are navigable and never overstate what has
 * been verified.
 */
export function LegalDocument({
  title,
  updated,
  intro,
  sections,
}: {
  title: string
  updated: string
  intro: string
  sections: LegalSection[]
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-14 sm:px-6 lg:px-8">
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm leading-relaxed text-amber-200/90">
        <strong className="font-semibold">Draft document — pending legal review.</strong> This text has
        not yet been reviewed by external counsel. It summarises the rules published in the PFT
        rulebook and on this website; where it differs from the rulebook, the rulebook governs.
        Review this document before relying on it.
      </div>

      <h1 className="mt-10 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">Last updated: {updated}</p>
      <p className="mt-6 text-base leading-relaxed text-muted-foreground">{intro}</p>

      <div className="mt-10 space-y-10">
        {sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{section.heading}</h2>
            <div className="mt-3 space-y-4 text-sm leading-relaxed text-muted-foreground">{section.body}</div>
          </section>
        ))}
      </div>

      <div className="mt-14 border-t border-border pt-6 text-xs text-muted-foreground">
        <p>
          Professional Funded Trader Ltd · <a href="mailto:support@pft.trade" className="text-highlight underline-offset-2 hover:underline">support@pft.trade</a>
        </p>
      </div>
    </main>
  )
}
