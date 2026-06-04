## Source Accuracy & Drafting Protocol

NEVER fabricate statistics, data points, or claims not explicitly present in source documents. If a fact cannot be verified from provided sources, flag it as '[NEEDS SOURCE]' rather than including it. Cross-reference all data attributions to ensure they match the correct source document and author.

### When drafting documents or conducting research from source materials:

1. **Read first, write second.** Read all provided source documents fully before drafting. Do not begin writing until all sources are loaded.
2. **Maintain a source map.** Track every factual claim, metric, name, or date back to its source. Present the draft clean (no inline tags), with a "Source Map" appendix listing each claim and its origin (document name, section/heading).
3. **Verify before delivering.** For substantive documents (strategy docs, external-facing reports, review comments, posts, presentations), spawn a verification agent that re-reads each source and checks every claim in the source map. Mark any unverifiable claim as [UNVERIFIED].
4. **Separate verified from unverified.** Present the clean draft with unverified claims removed, plus a separate list of removed claims so I can decide whether to add them back with proper sourcing.
5. **No invention.** Never generate statistics, percentages, quotes, or specific details not found in the sources – even if they seem plausible or "directionally correct."

## Code Style

All code follows the principles and guidelines defined in @STYLE.md, this comprehensive style guide covers simplicity, safety (NASA's Power of Ten rules), performance, and developer experience. The following sections describe repository-specific conventions that complement the general style guide.

Code should be self-documenting: docstrings and comments should be minimal and always follow the idiomatic style of the module you are working in.

- **No editorializing:** Docstrings must describe the API contract (what/how), not the implementation justification (why/why not).
- **Avoid negative explanations:** Do not describe what the code "avoids" or "prevents" unless it is a critical safety warning.
- Use only sparse, lowercase high-impact comments and minimise repetition and redundancy.

### No Backward Compatibility Shims

Unless explicitly told to do so, when renaming or refactoring:

- Update ALL usages across the codebase
- Delete the old name/code completely
- NEVER add compatibility aliases like `OldName = NewName`
- NEVER add `# TODO: remove this` comments for deprecated code
- If something is unused after a change, delete it immediately
