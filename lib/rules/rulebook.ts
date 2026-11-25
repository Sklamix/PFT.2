/**
 * Typed access to the build-time-generated rulebook (lib/rules/rulebook.generated.json).
 *
 * The AI support path and the rules browser both read the same generated file so
 * there is a single source of truth. Nothing here parses `docs/PFT-rulebook-v1.md`
 * at runtime — that file is the legal source of truth and is not used by AI.
 */
import raw from './rulebook.generated.json'

export type RuleSection = { id: string; num: number; title: string; markdown: string }
export type Rulebook = { version: string; effective: string; sourceHash: string; sections: RuleSection[] }

export class RulebookInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RulebookInvalidError'
  }
}

function isValidSection(value: unknown): value is RuleSection {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.num === 'number' && typeof record.title === 'string' && typeof record.markdown === 'string'
}

export function getRulebook(): Rulebook {
  const value = raw as { version?: unknown; effective?: unknown; sourceHash?: unknown; sections?: unknown }
  if (typeof value.version !== 'string' || typeof value.effective !== 'string' || typeof value.sourceHash !== 'string' || !Array.isArray(value.sections)) {
    throw new RulebookInvalidError('Malformed rulebook.generated.json')
  }
  if (value.sections.some((section) => !isValidSection(section))) {
    throw new RulebookInvalidError('Malformed rulebook sections')
  }
  return value as Rulebook
}

/** Exact-match lookup by section number (not array index). */
export function getSection(num: number): RuleSection | null {
  return getRulebook().sections.find((section) => section.num === num) ?? null
}

export const RULEBOOK_VERSION = getRulebook().version
