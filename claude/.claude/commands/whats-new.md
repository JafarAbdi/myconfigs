---
description: Track a package's new features per version inside that package's skill, as runnable pinned examples
argument-hint: "<package> <version> [checkout path]"
---

Update the feature notes for package `$1` at version `$2`. `$3`, if given, is a local checkout of the package to read.

If `$1` or `$2` is missing, ask before doing anything else. `$3` is optional and is never written down anywhere — it is a path on one machine, and these skills are checked into a dotfiles repo that syncs across machines.

Resolve `$2` to the exact release from the changelog headings first — `3.11` means `3.11.0`, and `3.8.0` and `3.8.1` are separate releases. Use the resolved string as the filename and the pin everywhere below.

## Layout

Everything lives in `~/.claude/skills/$1/`:

- `versions/<version>.<ext>` — one runnable file per version, holding that version's features in the package's native language (`<ext>` comes from the config below). This is the only place the code lives.
- `SKILL.md`, in a `## Versions` section at the end — the index: one bullet per feature, naming the function that demonstrates it (or, for a not-run-here feature, its existence check and the pinned command).

The `## Versions` section opens with the config — machine-independent lines giving the changelog URL, the file extension, and how to run one version file:

```
Changelog: <url>
Ext: <extension, e.g. py or sh>
Run: <command running one file; {ver} is the version, {file} the path>
```

`Run` is a template. Where the pin lives inside the file — Python's inline `# /// script` deps — `{ver}` need not appear: `uv run --no-project {file}`. Where the pin lives in the command — a pinned image tag — it does, and the file arrives over stdin so no bind mount is needed: `podman run --rm -i quay.io/podman/stable:v{ver} sh < {file}`.

If the skill or the section does not exist, ask me for the changelog URL and the ecosystem, write these lines, and continue. Never guess them.

## What to read

The changelog, and — when I give you `$3` — that checkout's own changelog (`doc/changelog.rst` or equivalent), source, docs, and tests, which are authoritative and offline. Without `$3` you have the URL and the released version however this ecosystem ships it — a PyPI package, a container image, a distro package — which is enough; do not go hunting my filesystem for a checkout.

The changelog is the starting point, not the deliverable. This is about the newest features and how to use them — a real, useful API that the changelog barely mentions still belongs here, and a changelog bullet with nothing usable behind it does not.

Read at least four versions back from `$2`, so you can see what later versions did to each feature. If a checkout you were given is older than `$2`, say so in your report and name its version — do not claim source verification you could not do, and do not update the checkout yourself.

## The version file

`versions/$2.<ext>` starts with whatever header its `Run` recipe needs to execute at the pinned version, then a one-line docstring. Where the pin lives in the file, write it in that header; where the pin lives in the `Run` command, the header is just the docstring. Python's header carries the pin inline:

```python
# /// script
# dependencies = ["$1==$2"]
# ///
"""New in $1 $2 (release date)."""
```

Then one function per feature. Each one is a worked example of the way this feature is *meant* to be used on this version — written the way I would want it written in my own code, following my conventions for this language and its domain, not a smoke test that proves the symbol exists. Someone reading it should come away knowing which API to reach for and how to hold it. That includes:

- a one-line docstring saying what the feature is for;
- a realistic use of it end to end, with whatever setup that honestly requires — the point is the shape of good usage, not the fewest lines;
- one comment line when the feature is the current best way to do something people used to hand-roll or do with an older API, so the right tool is obvious;
- the arguments and options worth knowing, used rather than listed;
- a print of the result that shows what actually happened.

This is code I will copy from, so load the style skills for this language (`python-style` and `python-modern` when `Ext` is `py`) before writing it, plus any skill covering the package's own domain.

A `main()` (or the file's top-level body) calls them all.

Keep functions self-contained: build models, data, and inputs inline rather than reading files from disk. Self-contained does not mean toy — a throwaway example that would fall apart in real use is worse than no example.

Every feature lands in one of three places:

- **Runs in this session** — a worked-example function in `versions/$2.<ext>`, exercised by the run below with its real output.
- **Real but not exercisable here** — needs state you lack (a VM, a registry, another OS, a GPU, a display). Still gets a function, but one that only asserts the surface survives — `podman machine restart --help` exiting 0 — so the sweep still fails when a later version renames it. The worked behaviour and its expected output, copied from the docs, go in the SKILL.md bullet labelled `not run here: needs <what>`. (A silently changed default with no surface to probe is the one case the sweep cannot cover: a plain bullet, no function.)
- **No user-visible surface** — bug fixes, build changes, doc edits. Skip entirely.

## Run everything, every time

Set **every** `versions/*` file to the resolved version — bump the in-file pin, and/or fill `{ver}=$2` in the `Run` recipe — then run each one with the config's `Run` line. That version bump is the only edit an older file gets unless one of its functions actually fails — do not tidy or refactor files that still pass.

```
<the config's Run line, with {ver}=$2 and {file}=~/.claude/skills/$1/versions/<version>.<ext>>
```

Ecosystem caveats live in that `Run` line, not here — e.g. Python's must carry `--no-project`, or `uv`, sitting inside this git repo, picks up an up-tree environment and quietly ignores the pin.

That run is the removal sweep. A function that was fine under an older release and now fails is a feature that `$2` removed, renamed, or changed — so fix it or delete it. Do not chase this through changelog prose; the failure is the evidence.

Every file must exit clean before you are done. Paste the real output in your report, never a plausible one. A feature you cannot exercise here belongs in the not-run-here bucket above — swept by an existence check, documented with expected output — never a worked example left looking verified when it never ran. If the `Run` recipe itself will not run here (tool missing, no network, tag unresolved), say so plainly and do not fake the sweep.

The `Run` recipe must be isolated — a throwaway environment or container, never an install into my machine.

## Removals apply across the whole skill

When `$2` removes, renames, or replaces something:

- delete the function and its bullet, or rewrite both to the new API and leave them under the version that introduced the feature, with the rename stated in the bullet;
- no strikethroughs, no "deprecated in X" tombstones — git is the history;
- fix anything else in `SKILL.md` that `$2` just broke, not only the `## Versions` section.

Version sections accumulate; never drop one for being old. What survives is what currently works.

## Finish

- `## Versions` lists versions newest first, each a `###` heading with the release date, each bullet naming its function, or for a not-run-here feature its existence check and pinned command — for example `` `spec_frames` — attach a subtree at a frame without recompiling ``.
- Keep the skill file's existing conventions: if it has a table of contents or numbered headings, update them.
- Report what you added, rewrote, and deleted, which versions you covered, and anything that could not be run.
- Then stop. Do not touch files outside that skill.
