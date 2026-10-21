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
