---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Coding Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876).

Bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding
- State assumptions explicitly. Uncertain → ask.
- Multiple interpretations exist → present them, don't pick silently.
- Simpler approach exists → say so. Push back when warranted.
- Unclear → stop. Name confusion. Ask.

## 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility/configurability not requested.
- No error handling for impossible scenarios.
- 200 lines that could be 50 → rewrite.

**Test:** "Would a senior engineer call this overcomplicated?" If yes, simplify.

## 3. Surgical Changes
Touch only what required. Clean only your own mess.
- Don't improve adjacent code, comments, formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Notice unrelated dead code → mention, don't delete.
- Remove imports/vars made unused BY YOUR changes only.

**Test:** every changed line traces directly to user's request.

## 4. Goal-Driven Execution
Define success criteria. Loop until verified.
- "Add validation" → write tests for invalid inputs, make them pass.
- "Fix the bug" → write test reproducing it, make it pass.
- "Refactor X" → tests pass before and after.

Multi-step: state plan as `[step] → verify: [check]`.

Strong criteria → loop independently. Weak ("make it work") → constant clarification.

## 5. Root Cause Over Symptom
Diagnose before patching. Symptom-level fix hides bug, returns later somewhere worse.
- Test fails → understand why, don't loosen assertion or add `try/except`.
- Crash on None → find why None reached here, don't blanket-guard.
- Flaky test → find race/order dependency, don't add retries or `sleep`.
- Type error → fix the wrong type at the source, don't `cast`/`# type: ignore`.
- Build breaks after upgrade → read changelog, don't pin to old version silently.

Legitimate symptom-level fix: root cause is out of scope (third-party bug, OS quirk). Then leave a comment naming the cause and link.

**Test:** "If I delete this fix, what's the actual broken thing underneath?" If you can't answer, you patched a symptom.

## Anti-Patterns

| Principle | Anti-Pattern | Fix |
|-----------|--------------|-----|
| Think Before Coding | Silently assumes format/fields/scope | List assumptions, ask |
| Simplicity First | Strategy pattern for single calc | One function until complexity needed |
| Surgical Changes | Reformats quotes, adds types while fixing bug | Only change lines that fix issue |
| Goal-Driven | "I'll review and improve" | "Write test for X → make pass → verify no regressions" |
| Root Cause | `try/except: pass` to silence error | Trace origin, fix where invariant broke |

## Key Insight

Overcomplicated code follows patterns/best practices. Problem is **timing**: complexity before needed = harder to understand, more bugs, slower, harder to test.

Good code solves today's problem simply, not tomorrow's prematurely.
