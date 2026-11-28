# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes.
Bias: caution over speed on non-trivial work.

## 1. Think Before Coding
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First
- Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked. No abstractions for single-use code.
- If 200 lines could be 50, rewrite it simply.

## 3. Surgical Changes
- Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Remove imports/variables that YOUR changes made unused.

## 4. Goal-Driven Execution
- Define strict success criteria. Loop until verified.
- Write tests for invalid inputs or bugs first, then make them pass.

## 5. Code Orientation
- For questions about structure, callers, or blast radius, query the knowledge graph
  before grepping: `graphify query "<question>"`, `graphify explain "<symbol>"`,
  `graphify path "<A>" "<B>"`. Output lands in `graphify-out/` (gitignored).
- Fall back to `grep` for exact-string lookups, and to `Read` for the file you are
  about to edit — the graph tells you which file, not its contents.
- The graph is a snapshot. Run `graphify update .` after changing code, otherwise
  answers describe an older tree.
- The graph covers code only. Never use it to infer database state, migration
  status, or runtime configuration — query the database for that.
