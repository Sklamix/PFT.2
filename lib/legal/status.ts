/**
 * Publication status of the legal documents. These pages are only published
 * after counsel-approved text and legal entity details are available, so the
 * release checklist can report them as an open blocker instead of guessing.
 */
export type LegalDocument = {
  slug: string
  title: string
  published: boolean
}

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  { slug: 'terms', title: 'Terms of Service', published: false },
  { slug: 'privacy', title: 'Privacy Policy', published: false },
  { slug: 'risk', title: 'Risk Disclosure', published: false },
  { slug: 'aml', title: 'AML/KYC Policy', published: false },
  { slug: 'refund', title: 'Refund Policy', published: false },
]

export function pendingLegalDocuments() {
  return LEGAL_DOCUMENTS.filter((document) => !document.published)
}
