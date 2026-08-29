---
name: mms
description: Media management system extension for swamp — content discovery from torrent/usenet sources, local-file deduplication, download protocol routing (Transmission/SABnzbd), and LLM-powered filename parsing and organization. Use when working with the @keeb/mms package or any of its model types (@keeb/mms/source, @keeb/mms/dedup, @keeb/mms/downloader, @keeb/mms/organizer), its reports (@keeb/mms/discovery-summary, @keeb/mms/dedup-summary, @keeb/mms/download-status), or building workflows that search SubsPlease/Nyaa/EZTV/Newznab feeds, filter against on-disk files, hand off magnet/NZB URIs to Transmission or SABnzbd, or move/rename completed downloads. Triggers on "mms", "discover anime", "discover episodes", "find new episodes", "search nyaa", "search subsplease", "search eztv", "search newznab", "dedup episodes", "skip already downloaded", "add torrent", "add nzb", "transmission", "sabnzbd", "organize media", "rename downloads", "media organizer", "ollama filename parse".
---

# mms — Media Management System

The `@keeb/mms` extension wires content discovery, deduplication, download
backends, and LLM-driven file organization into a single swamp pipeline.

## Models

All four models live under the `@keeb/mms` namespace and write `episode`,
`download`, or `job` resources via `context.writeResource`. They are normally
chained together with CEL `data.latest(...)` references in a workflow.

### `@keeb/mms/source` (model file: `mms_source.ts`)

Discovers episodes from torrent/usenet feeds. Factory model — one resource per
item.

- **Resource**: `episode` (lifetime infinite, GC=50). Fields: `show`,
  `episode?`, `magnet` (also holds NZB URLs), `provider`, `resolution`,
  `infoHash?`, `publishDate?`, `rawTitle?`, `seeders?`, `protocol?` (`torrent` |
  `usenet`), `size?`.
- **Global args**: `shows: []` — array of `ShowConfig` consumed by
  `search_configured`. Each entry: `name`, `provider`
  (`subsplease|nyaa|eztv|newznab`), `resolution` (default `"1080"`),
  `preferGroup?`, `preferCodec?`, `nyaaUser?`, `nyaaQuery?`, `eztvUrl?`,
  `newznabUrl?`, `newznabApiKey?` (sensitive), `newznabCat?`.
- **Methods**:
  - `search` — one-shot search of a single provider/query. Args mirror
    `ShowConfig` plus `query`. Use for ad-hoc discovery.
  - `search_configured` — iterates `globalArgs.shows`, fetches the EZTV feed
    once and reuses it across all EZTV shows (single-pull optimization). Prefer
    this for routine runs — multiple parallel `search` calls contend on the
    per-model lock.

Provider notes:

- **subsplease** — anime, returns parsed `episode` numbers. No auth.
- **nyaa** — general anime/torrents. Returns `rawTitle` only (no parsed
  `episode`); downstream `dedup.filter` parses with regex/LLM. Supports
  `nyaaUser` (uploader filter, e.g. `Erai-raws`) and `nyaaQuery` (override
  search term). Skips batch releases (e.g. `01~12`).
- **eztv** — western TV via myrss.org/eztv mirror. Supports `preferGroup` and
  `preferCodec` quality scoring; deduplicates by `S01E09`-style key keeping the
  highest score per episode.
- **newznab** — usenet (althub, nzbgeek, etc.). Stores the NZB URL in the
  `magnet` field and sets `protocol: "usenet"`. Default category `5040` (TV HD).
  MeGusta and HEVC/x265 releases get scoring boosts.

### `@keeb/mms/dedup` (model file: `mms_dedup.ts`)

Reads episode data from another model and emits only those NOT already on disk.

- **Resource**: `episode` (same shape as source).
- **Global args**: `checkDirs: string[]` (required), `ollamaUrl` (default
  `http://localhost:11434`), `ollamaModel` (default `qwen3:14b`).
- **Method**: `filter` — args: `sourceModel: string`. Reads via
  `context.readModelData(sourceModel, "episode")`, parses missing
  `show`/`episode` from `rawTitle` first with regex (handles `S01E06`, `1x06`,
  anime `- 06`, bare `1106`), falling back to Ollama for the rest. Loads
  `prompts/filename-to-json.prompt` from `context.repoDir` at execution time.
- Looks for existing files in three layouts under each `checkDir`:
  `{dir}/{show-slug}/s{season}/*`, `{dir}/{show-slug}/*` (flat), and `{dir}/*`
  (staging). Match key is `show name in filename + episode regex`.
- After dedup, keeps one resource per `show+season+episode`, preferring MeGusta
  then HEVC/x265.

### `@keeb/mms/downloader` (model file: `mms_downloader.ts`)

Routes magnets to Transmission and NZB URLs to SABnzbd.

- **Resource**: `download`. Fields: `id`, `name`, `uri`, `protocol`, `status`,
  `backend`, `addedAt`, `completedAt?`, `progress?`.
- **Global args**: `transmissionUrl?`, `transmissionUser?`,
  `transmissionPassword?` (sensitive), `sabnzbdUrl?`, `sabnzbdApiKey?`
  (sensitive). Methods throw if the relevant backend isn't configured.
- **Methods**:
  - `add` — args: `uri`, `protocol` (`torrent`|`usenet`), `downloadDir?`. Picks
    backend by protocol. Handles Transmission's 409 session-id refresh.
  - `status` — no args. Factory: pulls all torrents from Transmission and all
    queue slots from SABnzbd, writing one `download` resource per item. Maps
    Transmission's numeric status into strings (`stopped`, `downloading`,
    `seeding`, etc.).
  - `remove` — args: `filter` (substring, case-insensitive), `deleteData`
    (default `true`). Transmission only.
  - `clean` — args: `completedOnly` (default `true`), `deleteData` (default
    `false`). Removes completed Transmission torrents and clears SABnzbd
    completed history.

### `@keeb/mms/organizer` (model file: `mms_organizer.ts`)

Pops jobs from a MongoDB `jobs` collection, classifies filenames with Ollama,
and moves files into an organized media tree. This is the standalone
post-download stage; it does NOT read from the swamp data model.

- **Resource**: `job`. Records each processed job with `mediaType`, `title`,
  `season?`, `episode?`, `year?`, `sourcePath`, `destPath`, `status`
  (`processed|failed|duplicate`), `confidence`.
- **Global args**: `mongodbUri` (sensitive, required), `database` (default
  `media`), `ollamaModel` (default `qwen3:14b`), `ollamaUrl` (default
  `http://localhost:11434`), `stagingDir` (required), `mediaRoot` (required).
- **Method**: `process` — args: `maxJobs` (default `5`). Atomic
  `findOneAndUpdate` pops a `pending|queued|null` job and sets `in_progress`,
  walks the staging path for video files (extension whitelist), runs two Ollama
  prompts in sequence (`filename-to-json.prompt` then
  `json-to-save-path.prompt`, both loaded from `context.repoDir/prompts/`), then
  `Deno.rename`s with cross-device copy+delete fallback. Marks the MongoDB doc
  `done` or `failed` with the error.
- The save-path prompt has `/home/keeb/media` hardcoded; the model `replaceAll`s
  it with the configured `mediaRoot` before sending to the LLM.

## Reports

Each report is `scope: "method"` and runs against the `dataHandles` from a
single method execution. Markdown summary plus JSON for downstream tooling.

- **`@keeb/mms/discovery-summary`** — used by `mms/source`. Splits items into
  structured (have `episode`) vs. raw (nyaa-style, no `episode`). Groups
  structured by show, lists episode numbers; groups raw by provider with the
  first 10 titles.
- **`@keeb/mms/dedup-summary`** — used by `mms/dedup`. Lists what's new per
  show, or `Nothing new.` if everything was on disk.
- **`@keeb/mms/download-status`** — used by `mms/downloader`. Groups downloads
  by status (`downloading`, `added`, `seeding`, `completed`) with percentage.

## Common patterns

### Pipeline shape

`source.search_configured` → `dedup.filter (sourceModel: source)` →
`downloader.add` (one call per new episode, wired with CEL).

### CEL wiring

Always reference upstream data with the first-class API:

```yaml
uri: ${data.latest("my-dedup", "episode").attributes.magnet}
protocol: ${data.latest("my-dedup", "episode").attributes.protocol ?? "torrent"}
```

Not the deprecated `model.<name>.resource.<spec>...` form.

### Vault credentials

All sensitive global args (`transmissionPassword`, `sabnzbdApiKey`,
`mongodbUri`, `newznabApiKey`) are marked `sensitive: true` in their Zod
schemas. Wire them through the swamp vault rather than literal YAML:

```yaml
globalArguments:
  transmissionPassword: ${vault("transmission/password")}
  sabnzbdApiKey: ${vault("sabnzbd/api-key")}
  mongodbUri: ${vault("mms/mongodb-uri")}
```

### External dependencies

- **Ollama** running locally (or wherever `ollamaUrl` points), with the
  configured model pulled. `mms/organizer` health-checks `/api/tags` before
  popping jobs. `qwen3:14b` is the default — keep it consistent across `dedup`
  and `organizer` so prompts behave the same.
- **Transmission RPC** at `transmissionUrl/transmission/rpc`. The downloader
  handles 409 session-id refresh automatically.
- **SABnzbd API** at `sabnzbdUrl/api`.
- **MongoDB** with a `jobs` collection where each doc has at minimum a `name`
  field and a `status` of `pending`, `queued`, or null. The organizer mutates
  status to `in_progress`, `done`, or `failed`.
- **Prompts**: the two `.prompt` files in `prompts/` (`filename-to-json.prompt`
  and `json-to-save-path.prompt`) are loaded at execution time from
  `context.repoDir`. They MUST exist in the repo at runtime — they are not
  bundled into the extension.

## Example global args (definition YAML)

```yaml
- name: anime-source
  type: "@keeb/mms/source"
  globalArguments:
    shows:
      - name: "Frieren"
        provider: subsplease
        resolution: "1080"
      - name: "The Apothecary Diaries"
        provider: nyaa
        nyaaUser: "Erai-raws"
        resolution: "1080"
      - name: "Silo"
        provider: eztv
        resolution: "1080"
        preferGroup: "MeGusta"
        preferCodec: "HEVC"

- name: anime-dedup
  type: "@keeb/mms/dedup"
  globalArguments:
    checkDirs:
      - /home/keeb/media/anime
      - /home/keeb/media/tv
      - /mnt/staging

- name: torrent-box
  type: "@keeb/mms/downloader"
  globalArguments:
    transmissionUrl: "http://transmission.lan:9091"
    transmissionUser: "keeb"
    transmissionPassword: ${vault("transmission/password")}
    sabnzbdUrl: "http://sabnzbd.lan:8080"
    sabnzbdApiKey: ${vault("sabnzbd/api-key")}
```

## Gotchas

- **Nyaa items have no `episode` field.** Always pipe nyaa output through
  `mms/dedup`, which parses titles via regex first then Ollama. Skipping dedup
  loses the episode number entirely.
- **The `magnet` field carries NZB URLs** for the `newznab` provider and usenet
  downloads. The downloader picks the backend off `protocol`, not the URI shape.
  Always set `protocol` when wiring `downloader.add`.
- **Prompts are NOT bundled.** `mms/dedup` and `mms/organizer` read prompt files
  via `context.repoDir/prompts/...` at runtime. Extensions installed without the
  surrounding repo (or in CI without the `prompts/` dir) will fail at execution
  time.
- **The save-path prompt hardcodes `/home/keeb/media`.** The organizer
  `replaceAll`s it with `mediaRoot`, but if you edit the prompt, keep that
  literal in place so the substitution still fires.
- **`mms/organizer` is filesystem-coupled.** Cross-device moves fall back to
  copy+delete; ensure swamp has write access to both `stagingDir` and
  `mediaRoot`. Duplicate detection compares file sizes only.
- **Transmission 409 refresh is built in** — don't wrap calls with extra retry
  logic.
- **`search_configured` over `search` loops.** The single fan-out method
  acquires the per-model lock once; running N parallel `search` calls against
  one source model causes lock contention.
- **EZTV quality scoring requires both `preferGroup` and/or `preferCodec`** to
  be set — without them, dedup-by-`S01E09` is skipped and you may get duplicate
  releases for the same episode.
