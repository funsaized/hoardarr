# Check documentation prose

Hoardarr uses [Vale](https://github.com/vale-cli/vale) with the
[Google style package](https://github.com/vale-cli/Google), six rules from
[tbhb's ai-tells](https://github.com/tbhb/vale-ai-tells), and local naming and terminology rules.
Deno formats Markdown. All prose findings are advisory in v1, including spelling and terminology.
Fix useful findings and preserve technical meaning. A phrase match does not prove AI authorship.

## Install once

You need Git and Python 3.10 or later. From the repository root:

```sh
deno task docs:setup
```

Setup downloads Vale 3.26.0, Google 0.7.1 and tbhb ai-tells 1.37.0, verifies their SHA-256 hashes,
and installs them under `.vale/`. Git ignores the executable and downloaded styles; the repository
tracks the lock file, configuration, local rules and vocabulary. Setup needs network access; scans
work offline and require no global Vale installation.

The installer supports Linux, macOS and Windows on x86-64 and ARM64. Deno tasks invoke `python3`.
You can also run the Python script directly without Deno. On Windows with the Python launcher:

```powershell
py -3 tools/docs_lint.py setup
py -3 tools/docs_lint.py all
py -3 tools/docs_lint.py changed
```

Rerun setup after changing `.vale/tools.lock.json`. Use the installer instead of `vale sync` so
package layouts and checksum verification follow the lock.

## Scan prose and read the output

```sh
deno task docs:lint                                  # Current repository
deno task docs:lint:changed                          # Uncommitted changes
deno task docs:lint:changed --base HEAD^              # Last commit and local edits
deno task docs:lint:changed --base origin/master      # Branch changes and local edits
```

The full scan includes tracked and untracked Markdown within the scope below, except files Git
ignores. The changed scan includes staged, unstaged and untracked files. `--base` adds committed
changes since the merge base with that revision. Fetch the base branch first if your reference is
stale. After pushing to `origin/master`, use `HEAD^` to inspect the last commit.

The scanner checks whole files, uses rename destinations and skips deleted files. Findings can refer
to lines you did not edit. Append `--list` to inspect selected paths. Scans check the pinned Vale
version and ignore personal Vale configuration; an empty selection succeeds without Vale.

Results appear in the terminal. To save them as JSON:

```sh
deno task docs:lint --output JSON > vale-results.json
```

Keep generated reports out of commits. In GitHub Actions, open **CI → documentation → Scan
reader-facing prose (advisory)** for the full scan. Prose findings do not fail the job; missing
tools, invalid rules and execution errors do. The job runs separately from application and container
checks. Promoting spelling or terminology to errors needs another calibration pass. Keep style and
AI-prose feedback advisory.

## Scope

The profile covers `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, Markdown under `docs/`, and
Markdown explanations under `examples/`, including maintained migration guides and redirect pages.
Vale skips inline code and fenced code blocks.

The profile excludes:

- Generated docs, archives, evidence and benchmarks under `docs/generated/`, `docs/archive/`,
  `docs/evidence/`, `docs/benchmarks/` and `docs/qualification/results/`.
- Example fixtures and captured outputs under `examples/fixtures/` and `examples/outputs/`.
- Source comments, structured examples, tests, release output, runtime data, licenses, third-party
  notices and deployment qualification captures outside the included paths.
- `AGENTS.md`, `SKILL.md`, agent definitions, prompts and skills. Calibrate a separate profile
  before including operational instructions.

Some exclusions reserve paths for future generated material. Keep agent definitions and prompts
outside the reader-facing directories. If the layout changes, update `.vale.ini` and the selection
in `tools/docs_lint.py`, then test their agreement. Editors can use `.vale/bin/vale` (or `vale.exe`)
with the root `.vale.ini`.

## Rules and vocabulary

Vale checks spelling and repeated words. Add verified project terms, provider names and protocols to
`.vale/styles/config/vocabularies/Hoardarr/accept.txt`. Case patterns such as `[Dd]ownloaders?`
allow ordinary words at the start of a sentence. Put preferred substitutions in the local rules.

Use Hoardarr, DevVM, Torlink, Gluetun, NordVPN and Tailscale in prose; put literal command names in
code spans. Use “Swamp behavior” for the older “Swamp model” terminology.

The six AI-prose rules run at suggestion level:

| Rule                     | Looks for                       |
| ------------------------ | ------------------------------- |
| `FillerPhrases`          | Padding                         |
| `PromotionalPuffery`     | Inflated claims                 |
| `OpeningCliches`         | Stock openings                  |
| `StructureAnnouncements` | Announcements of the next point |
| `ContrastiveFormulas`    | Formulaic contrasts             |
| `VagueAttributions`      | Unnamed sources                 |

No other AI-prose rules run. Review each match: useful distinctions and qualifications can trigger
these checks too.

The initial calibration covered the README, first-run tutorial, configuration reference and
networking explanation. These represent an overview, tutorial, API-like reference and trust-boundary
explanation. Untuned Google and Vale rules produced 114 findings (47, 6, 30 and 31 respectively);
the selected AI rules found none. Vocabulary and rule tuning reduced the total to five valid
passive-voice descriptions: one in the tutorial and four in the configuration reference.

The profile disables Google's acronym, anthropomorphism, contractions, first-person, heading, Oxford
comma, parentheses, semicolon and two word-list checks. They flagged established CLI and VPN terms,
explicit negation, reader questions, table fragments and existing punctuation. The word list also
suggested “app” for “application” and “off” for “disabled” in runtime descriptions. Passive voice
remains a suggestion; other Google rules remain warnings.

## Review and maintain

Use Humanizer for an editorial pass when available. Preserve facts, code, paths, command output and
security boundaries. Neither tool verifies examples or agreement with the implementation. Run the
relevant tests and `python3 tests/docs_links.py`.

For a package update, edit its exact release URL, version and checksum in `.vale/tools.lock.json`.
For Vale, update all platform hashes. Run setup, inspect upstream rule changes, repeat the four-file
calibration and full scan, then run:

```sh
python3 -m unittest discover -s tests -p 'docs_lint_test.py'
```

Keep one primary technical style guide. Review this profile's noise before separately evaluating
grammar, readability or Diátaxis checks.
