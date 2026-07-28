---
description: Track a package's new features per version inside that package's skill, as runnable pinned scripts
argument-hint: "<package> <version> [checkout path]"
---

Update the feature notes for package `$1` at version `$2`. `$3`, if given, is a local checkout of the package to read.

If `$1` or `$2` is missing, ask before doing anything else. `$3` is optional and is never written down anywhere — it is a path on one machine, and these skills are checked into a dotfiles repo that syncs across machines.

Resolve `$2` to the exact release from the changelog headings first — `3.11` means `3.11.0`, and `3.8.0` and `3.8.1` are separate releases. Use the resolved string as the filename and the pin everywhere below.

## Layout

Everything lives in `~/.claude/skills/$1/`:

- `versions/<version>.py` — one runnable script per version, holding that version's features. This is the only place the code lives.
- `SKILL.md`, in a `## Versions` section at the end — the index: one bullet per feature, naming the function that demonstrates it.

The first line of the `## Versions` section is the config — the changelog URL, and nothing machine-specific:

```
Changelog: <url>
```

If the skill or the section does not exist, ask me for the changelog URL, write that line, and continue. Never guess it.

## What to read

The changelog, and — when I give you `$3` — that checkout's own changelog (`doc/changelog.rst` or equivalent), source, docs, and tests, which are authoritative and offline. Without `$3` you have the URL and the released package on PyPI, which is enough; do not go hunting my filesystem for a checkout.

The changelog is the starting point, not the deliverable. This is about the newest features and how to use them — a real, useful API that the changelog barely mentions still belongs here, and a changelog bullet with nothing usable behind it does not.

Read at least four versions back from `$2`, so you can see what later versions did to each feature. If a checkout you were given is older than `$2`, say so in your report and name its version — do not claim source verification you could not do, and do not update the checkout yourself.

## The version script

`versions/$2.py` starts with inline metadata pinned to the newest version being tracked, so `uv run` alone is enough to run it:

```python
# /// script
# dependencies = ["$1==$2"]
# ///
"""New in $1 $2 (release date)."""
```

Then one function per feature. Each one is a worked example of the way this feature is *meant* to be used on this version — written the way I would want it written in my own code, following my Python and domain conventions, not a smoke test that proves the symbol imports. Someone reading it should come away knowing which API to reach for and how to hold it. That includes:

- a one-line docstring saying what the feature is for;
- a realistic use of it end to end, with whatever setup that honestly requires — the point is the shape of good usage, not the fewest lines;
- one comment line when the feature is the current best way to do something people used to hand-roll or do with an older API, so the right tool is obvious;
- the arguments and options worth knowing, used rather than listed;
- a print of the result that shows what actually happened.

This is code I will copy from, so load my `python-style` and `python-modern` skills before writing it, plus any skill covering the package's own domain.

A `main()` at the bottom calls them all. Python only — if something has no Python surface but changes behaviour I would see from Python, it gets a SKILL.md bullet and no function.

Keep functions self-contained: build models, data, and inputs inline rather than reading files from disk. Self-contained does not mean toy — a throwaway example that would fall apart in real use is worse than no example.

Skip bug fixes, build changes, doc edits, and anything with no user-visible API.

## Run everything, every time

Bump the pin in **every** `versions/*.py` to the resolved version, then run each one. The pin is the only edit an older script gets unless one of its functions actually fails — do not tidy or refactor scripts that still pass.

```
uv run --no-project ~/.claude/skills/$1/versions/<version>.py
```

`--no-project` matters: the skill lives inside a git repo, and without it `uv` can pick up a project environment up-tree and quietly ignore the pin.

That run is the removal sweep. A function that was fine under an older release and now fails is a feature that `$2` removed, renamed, or changed — so fix it or delete it. Do not chase this through changelog prose; the failure is the evidence.

Every script must exit clean before you are done. Paste the real output in your report, never a plausible one. If something genuinely cannot run in this session (needs a GPU, a display, a large asset), say so in one line in its SKILL.md bullet rather than leaving a function that looks verified.

`uv run` with inline metadata is isolated — do not install anything into my environment.

## Removals apply across the whole skill

When `$2` removes, renames, or replaces something:

- delete the function and its bullet, or rewrite both to the new API and leave them under the version that introduced the feature, with the rename stated in the bullet;
- no strikethroughs, no "deprecated in X" tombstones — git is the history;
- fix anything else in `SKILL.md` that `$2` just broke, not only the `## Versions` section.

Version sections accumulate; never drop one for being old. What survives is what currently works.

## Finish

- `## Versions` lists versions newest first, each a `###` heading with the release date, each bullet naming its function — for example `` `spec_frames` — attach a subtree at a frame without recompiling ``.
- Keep the skill file's existing conventions: if it has a table of contents or numbered headings, update them.
- Report what you added, rewrote, and deleted, which versions you covered, and anything that could not be run.
- Then stop. Do not touch files outside that skill.
