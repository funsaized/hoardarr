# Check documentation prose

Hoardarr uses [Vale](https://github.com/vale-cli/vale) for repeatable prose feedback, the
[Google style package](https://github.com/vale-cli/Google) as its technical writing baseline, and
six rules from [tbhb's ai-tells](https://github.com/tbhb/vale-ai-tells). Local rules cover product
names and Swamp terminology. Deno formats Markdown.

All prose findings are advisory in v1, including spelling and terminology. Fix useful findings; keep
wording that expresses the technical meaning better than a suggested replacement. A phrase match
does not establish that a person used AI to write it.

## Install once

You need Git and Python 3.10 or later. From the repository root:

```sh
deno task docs:setup
```

Setup downloads Vale 3.26.0, Google 0.7.1 and tbhb ai-tells 1.37.0, verifies their SHA-256 hashes,
and installs them under `.vale/`. The executable and downloaded styles are ignored by Git. The lock
file, configuration, local rules and vocabulary are committed. Setup needs network access; linting
uses the installed files and works offline. A global Vale installation is unnecessary.

The installer supports Linux, macOS and Windows on x86-64 and ARM64. Deno tasks invoke `python3`. If
Windows provides Python through the launcher instead, use these equivalent commands:

```powershell
py -3 tools/docs_lint.py setup
py -3 tools/docs_lint.py all
py -3 tools/docs_lint.py changed
```

On any platform, you can invoke the script directly without Deno. Use Python 3.10 or later with the
executable name available on your system. Rerun setup after a tool lock change. Do not use
`vale sync` for this repository: the installer handles both package layouts and verifies downloads
against `.vale/tools.lock.json`.

## Scan prose

```sh
deno task docs:lint
deno task docs:lint:changed
deno task docs:lint:changed --base origin/master
```

The full scan includes tracked and untracked Markdown that is not ignored by Git. The changed scan
includes staged, unstaged and untracked files. With `--base`, it also includes committed changes
since the merge base with that revision. Fetch the base branch first if your local reference is
stale. Renames use the destination path; deleted files are skipped. Each selected file is checked in
full, so findings can refer to lines you did not edit.

Append `--list` to inspect selected paths or `--output JSON` for structured findings. If no files
match, the command succeeds without requiring Vale. Other scans require setup and check the pinned
version. Personal Vale configuration is disabled for reproducible results.

The dedicated documentation CI job runs one full scan. Warnings and suggestions do not fail it;
missing tools, invalid rules and other execution errors do. It is separate from the application and
container checks. Promoting spelling or terminology to errors requires a later calibration change;
style and AI-prose feedback should remain advisory.

## Scope

The reader-facing profile covers `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, Markdown under
`docs/`, and Markdown explanations under `examples/`. Maintained migration guides and short redirect
pages remain in scope. Vale skips inline code and fenced code blocks.

The following material is excluded:

- Generated docs, archives, captured evidence and benchmark records under `docs/generated/`,
  `docs/archive/`, `docs/evidence/`, `docs/benchmarks/` and `docs/qualification/results/`.
- Example fixtures and captured outputs under `examples/fixtures/` and `examples/outputs/`.
- Source comments, structured examples, tests and fixtures, release output, runtime data, licenses,
  third-party notices and deployment qualification captures outside the included paths.
- `AGENTS.md`, `SKILL.md`, agent definitions, prompts and skills. Operational instructions need a
  separately calibrated profile before they can be included.

Some excluded directories do not exist yet; the exclusions keep future generated material out of the
scan. Keep agent instructions and prompts outside the reader-facing directories. If the layout
changes, update both `.vale.ini` and the path selection in `tools/docs_lint.py`, then test their
agreement. Editor integrations can use `.vale/bin/vale` (or `vale.exe`) and the root `.vale.ini`.

## Rule choices

Vale supplies spelling and repeated-word checks. Accepted words live in
`.vale/styles/config/vocabularies/Hoardarr/accept.txt`. Add actual project terms, provider names or
protocols after checking their spelling. Use case patterns such as `[Dd]ownloaders?` for ordinary
words that can begin a sentence. Preferred substitutions belong in the local rules, not the accepted
word list. Product names use Hoardarr, DevVM, Torlink, Gluetun, NordVPN and Tailscale; literal
command names belong in code spans. In prose, use “Swamp behavior” for the older “Swamp model”
terminology.

The enabled AI-prose rules are `FillerPhrases`, `PromotionalPuffery`, `OpeningCliches`,
`StructureAnnouncements`, `ContrastiveFormulas` and `VagueAttributions`, all at suggestion level.
They cover padding, inflated claims, stock openings, announcements, formulaic contrasts and unnamed
sources. The rest of the package is disabled. Even an enabled rule can flag a useful distinction or
a real qualification: review the sentence before changing it.

The initial scan used the README, first-run tutorial, configuration reference (Hoardarr's API-like
reference sample), and networking explanation (its trust-boundary sample). The untuned Google and
Vale baseline produced 114 findings: 47, 6, 30 and 31 respectively. The selected AI rules produced
none. After vocabulary and rule tuning, the same files produced five passive-voice suggestions: one
in the tutorial and four in the configuration reference. Their state descriptions are valid, so they
remain for editorial review.

Calibration disabled Google's acronym, anthropomorphism, contractions, first-person, heading, Oxford
comma, parentheses, semicolon and two word-list checks. They repeatedly flagged established CLI and
VPN vocabulary, explicit negation, reader-oriented questions, table fragments and existing
punctuation. The word list also suggested “app” for “application” and “off” for “disabled” in
runtime descriptions. Passive voice stays enabled as a suggestion. Other Google rules remain
warnings.

## Review and maintain

Use Humanizer for an editorial pass when available. Preserve facts, code, paths, command output and
security boundaries. Vale and Humanizer do not verify examples or check documentation against the
implementation; run the relevant tests and `python3 tests/docs_links.py` as well.

When updating a package, edit its exact release URL, version and checksum in
`.vale/tools.lock.json`. For Vale, update all supported platform hashes. Run setup, inspect upstream
rule changes, repeat the four-file calibration, run the full scan and run the tooling tests:

```sh
python3 -m unittest discover -s tests -p 'docs_lint_test.py'
```

Keep one primary technical style guide. Evaluate additional grammar, readability or Diátaxis checks
separately after reviewing the noise from this profile.
