# Hoardarr refinement plan

Ship the dashboard first. Use the next release to record when a download would have switched to another release. Enable automatic switching after those observations show that the policy can distinguish a dead torrent from a slow transfer worth keeping.

## Starting point

Local commit `85d6232` captures the operator board that was running on the appliance. The synthwave dashboard, grouped backlog, compact library, and progress meters are in the working tree and sample-data preview. The acquisition, performance, and access changes below are planned work.

At inspection, the board reported 363 catalog entries, including 194 wanted and four downloading. Of the wanted items, 185 were episodes across eight shows and nine were movies. The four downloads reported roughly 0 B/s, 1.1 KiB/s, 0 B/s, and 9 B/s. Those readings justify collecting progress history. They give no duration for a stall.

The warm board response was about 95 KB and took 8 ms on loopback. The board service used about 34 MiB at inspection, with a recorded peak of 212 MiB. The guest had about 3.8 GiB of RAM and no swap. Use these as reference readings and repeat the measurements under comparable load.

## 1. Finish the dashboard

Keep the accepted Transfer Deck design. The vault emblem, striped sun, ridgeline, and small pointer-driven grid ripple give the board its identity. Keep the queue above the workflow controls. Use distinct motion for waiting, receiving, seeding, and attention. Reserve the receiving animation for fresh readings with positive throughput. Show the last observation time when data is stale.

Both the download bar and the word “Downloading” reveal the same fixed gradient from deep purple through pink and orange to yellow. At 75%, the left edge stays purple, the middle stays pink, and the leading edge reaches orange. A narrow highlight moves across the filled portion while bytes are arriving. Zero throughput pauses the highlight. Reduced-motion mode retains the gradient, text, and percentage.

Group the backlog by show, with a separate Movies group. For long shows, add season disclosure inside the show. Show the outstanding count, the next eligible episode, and the reason a title is waiting. Keep the Attention stage one click away. Use the compact multicolumn library on desktop and one column on phones. Preserve open groups, keyboard focus, selected item, and scroll position through refreshes.

**Acceptance.** Exercise the four sample percentages, 0%, completion, missing progress, stale readings, and reduced motion. Compare a desktop and a narrow phone layout with long titles and an expanded show. Open a backlog episode, allow two poll cycles, and verify that the same row stays in view. Check the screen reader’s progress value against the displayed percentage.

Implementation starts in [the board UI](deploy/board/board.js) and [its stylesheet](deploy/board/board.css).

## 2. Observe transfer health

During normal downloader reconciliation, store a bounded observation per active attempt. Record title identity, release hash, observation time, downloaded bytes when available, last confirmed progress, and eligible time without progress. Keep a short event history for state changes. The scheduler must work with every browser closed.

Count time only while Torlink reports the attempt active and the network and downloader readings are fresh. Exclude time spent queued, paused, under maintenance, or waiting for an unavailable provider. Give metadata acquisition its own grace period. After a restart or a long sampling gap, establish a fresh baseline before counting again. Treat a missing or decreasing byte counter as uncertain. Rounded percentages can stay unchanged while a large torrent is receiving data.

Start with a configurable **30 minutes of observed zero byte growth** across multiple fresh readings. Record slow transfers separately using byte growth over time and estimated time remaining where reliable. During observation, show the trigger, evidence, and proposed action in the board. Review examples of both a dead swarm and a slow torrent that later recovered before choosing a low-throughput threshold.

**Acceptance.** Replay zero peers, slow steady growth, missing counters, a queue delay, a VPN outage, and a guest restart. Check recorded decisions and time accounting. Observation mode must issue zero downloader control commands.

## 3. Rotate through eligible releases

Extend existing movie and episode ranking to retain up to three distinct eligible hashes per title. Apply the existing identity, quality, and rejection rules before ranking. Merge duplicates across providers. Persist rank, source, selection reason, attempt outcome, and next eligible time. Keep private locators inside the provider or protected catalog boundary. Existing records with a single selection remain valid.

Run one release per title. When a confirmed stall has a usable alternate, acquire the existing installation ownership, recheck free space and current observations, and persist the intended switch. Stop the old transfer, confirm its state with Torlink, and then admit the alternate. Reconcile an uncertain add by hash before retrying. Resume interrupted switches from the saved phase. If the original completes during the decision window, deliver it and cancel the switch.

Keep partial files until the downloader has detached and the existing storage ownership checks allow cleanup. Bound retained partials by available staging space. Apply a temporary cooldown to a stalled hash and retain identity-mismatch exclusions. When alternatives are exhausted, schedule rediscovery with backoff and expose the next retry. With no alternate, leave a viable transfer running. Initially gate switching behind an operator setting.

**Acceptance.** Interrupt the process before stop, after stop, and after an add with a lost response. Verify at most one active release per title, a bounded number of attempts, and exactly one verified delivery. Cover stale candidates, a shared hash referenced elsewhere, low disk space, an already-complete torrent, and attempts created before this change.

Implement through [pipeline reconciliation](extensions/models/pipeline.ts), the existing catalog definitions, and [the generated swamp workflows](src/workflows.ts). Preserve receipt verification before staging cleanup.

## 4. Improve discovery and parallelism

Preserve show rotation, request budgets, search cooldowns, and the existing overlap between acquisition and delivery. Add bounded fan-out inside the search method with a global limit, per-provider limits, request deadlines, and backoff that honors provider retry hints. Keep successful results when another source times out. Distinguish an empty successful search from a failed or partial search when scheduling the next attempt.

Expose the last successful search, eligible candidate count, rejection reasons, and next retry in title details. Distinguish waiting for discovery from waiting for a Torlink slot. Start with the existing download capacity. Tune search concurrency using request-to-first-eligible-release time, provider errors, completed deliveries per day, and staging headroom. Raise transfer concurrency separately only when measurements justify it.

**Acceptance.** Exercise one failing provider alongside a healthy one, rate limits, duplicate results, and a large TV backfill competing with a new request. Confirm bounded in-flight calls and continued progress for both request and automatic discovery. Use a single swamp behavior invocation for each fan-out batch to avoid lock contention.

### Discover titles when TMDB is unavailable

Today a show can be configured by name and year, but the native discovery path resolves it to TMDB before enumerating aired episodes. Movie discovery uses TMDB digital-release evidence. Catalog resource names, request targets, planner work keys, and board joins all assume TMDB identities. Saved discoveries can be replayed. A new provider alone cannot admit a previously unknown title with its own IDs. See [movie and TV discovery](extensions/models/movie_discovery.ts), [request resolution](extensions/models/_lib/request_metadata.ts), and [the planner](extensions/models/pipeline.ts).

1. **Keep known work moving.** Resolve requests against saved, confirmed identities first. Give metadata refresh its own outcome so an expired credential or outage cannot block release searches for already eligible titles. Record where and when a title was identified and where its air or release date came from. Preserve the last good observation through an empty or failed refresh.
2. **Give the catalog a local identity.** Allocate one durable ID per movie, series, and episode. Store provider IDs as typed aliases, unique within provider and media kind. Backfill mappings under the installation lease. Keep existing resource names, request links, active transfer hashes, library paths, and delivery receipts readable. Move planner and board joins onto the local ID before accepting records without a TMDB ID. Resume a partial migration idempotently.
3. **Add an independent TV path.** For tracked shows, try a confirmed external alias first. TVmaze supports IMDb and TVDB show lookups, title search, and per-show episode lists. Cache only tracked series and their episode lists. Carry the source numbering scheme through matching. Ask for a choice on remakes, conflicting episode orders, specials, and ambiguous air dates. Include source attribution and follow the provider's caching and rate-limit guidance. [TVmaze API](https://www.tvmaze.com/api)
4. **Separate movie identity from release eligibility.** Support a locally confirmed movie request with title, year, and optional aliases even without a metadata account. An optional on-disk index of IMDb titles and alternate names can resolve identities offline for eligible personal installations. Stream imports, swap the index only after validation, and keep the dataset outside the public image. The published fields include release year but do not establish a regional digital-release date. For autonomous discovery, ingest suggestions from configured release feeds and require dated regional digital-release evidence before spending the weekly allowance. Keep suggestions pending when that evidence is missing. Explicit requests retain their own acquisition policy. [IMDb dataset fields and usage terms](https://data.imdb.com/non-commercial-datasets/)
5. **Reconcile when providers return.** Link an exact verified alias to the existing local record. Use title, year, and episode numbering to suggest matches for review. A title string or torrent hash alone cannot establish a catalog merge. Surface unresolved matches, source conflicts, and missing release evidence in the dashboard so the operator can resolve each once.

**Acceptance.** Disable TMDB credentials on a qualification install. Deliver a known title, request a previously unknown movie by title and year, and discover a newly aired episode through the alternate provider. Check that conflicting remakes and unsupported movie release dates stay pending. Restore TMDB, replay both sources, and verify one catalog entry, one delivery, and an intact request history. Exercise migration interruption and repeat import during an active download.

## 5. Reduce board memory and polling cost

Project only board fields in the swamp catalog query. Today the service collects full attributes and trims them in memory. Keep the shared cache, independent refresh intervals, stale-on-error behavior, and nonblocking catalog warmup. Give each successful catalog snapshot a revision. Let clients reuse an unchanged catalog while fetching current transfer readings. Render expanded groups on demand and preserve their state when fresh data arrives.

Measure cold load, warm polls, response bytes per minute, board service peak memory during catalog refresh, and rendered row count with multiple tabs. Compare the same catalog and guest configuration before and after. Record downloader and delivery activity alongside memory readings so an unrelated workload does not distort the comparison.

**Acceptance.** A warm transfer poll omits unchanged catalog rows. Concurrent tabs share one catalog refresh. A failed refresh retains the last snapshot and marks it stale. An empty catalog, a cold start, or a service restart produces a usable board. Inspect returned fields for private locators. Record measured savings before considering further cache or concurrency changes.

Start in [the board service](deploy/board/service.ts) and [its cache and projection tests](tests/board_test.ts).

## 6. Make local operation keyless

The SSH tunnel binds to host loopback. At inspection, Tailscale Serve also forwarded a tailnet HTTPS route to that listener. Identify and retire the board’s proxy route and update the host setup instructions. Verify machine-only access before activating keyless commands. Keep the guest Unix socket private, the fixed command allowlist, and one operation at a time.

Remove key generation, the password field, and key retrieval instructions together. Require the expected loopback host and an exact same-origin browser request on command POSTs. Reject cross-origin and missing-origin submissions. Continue to run commands under the enrolled service identity with the existing installation gate.

**Acceptance.** Exercise Preview, Discover, and Run on a qualification instance through the intended local URL. Confirm that a concurrent run receives a busy response, cross-origin submissions fail, and the former tailnet route is unreachable from another device. Verify tunnel behavior after restart. Keep other Tailscale routes intact.

## Delivery and rollback

1. **Dashboard release.** Commit the reviewed UI with its regression checks. Verify backlog navigation, library density, motion preferences, and the blended progress treatment using representative data.
2. **Observation release.** Add transfer observations and board explanations. Collect examples over normal operation, including recovery after an outage. Record catalog polling and discovery baselines during this period.
3. **Discovery and board efficiency.** Start with cached resolution and metadata failure isolation. Migrate local identities before enabling alternate TV and movie sources. Introduce bounded searches and catalog revisions as separately reviewable changes. Compare measurements after each. Retain the serial search setting for rollback.
4. **Controlled switching.** Qualify restart recovery and verified delivery with fixtures. Enable switching for a limited workload, inspect attempts and false switches, then expand. Disable new switches if needed and reconcile any saved in-flight switch before resuming normal scheduling.
5. **Local access cutover.** Qualify the keyless image and perform the host route change in the order above. Keep the previous keyed image available until local access and remote isolation have both been confirmed.

For each appliance release, run relevant tests and workflow validation, build the application into the DevVM image, and deploy through the DevVM CLI. Preserve the selected backup and qualification scope, installation identity, configuration, media, and catalog on the persistent project. Verify service startup, VPN readiness, board freshness, and one acquisition through receipt-verified delivery within the agreed qualification scope. Build and test backward-compatible reads before rolling back an image that has written new attempt state. Inspect the swamp method or workflow report on failure before retrying.

The rollout is complete when the operator can explain why a title is waiting, see whether bytes are moving, and follow a failed release to its replacement and verified library entry. Record the measured changes in discovery latency, completed deliveries, memory, and polling traffic alongside the release used for comparison.

## Rollout evidence, November 25, 2026

- The dashboard replay used 363 production catalog rows and four transfers. Desktop and narrow phone views retained the expanded season, episode selection, keyboard focus and scroll position over two polls. Chromium exposed the displayed percentages in its accessibility tree. Gradient and reduced-motion fixtures covered 0%, 6%, 38%, 75%, 76%, 97%, completion and missing progress.
- On the original production image, the first board response after restarting the board service took 268 ms from restart. It contained four live transfers while the catalog loaded. Both snapshots were fresh after 4.28 seconds. Three concurrent warm polls returned 94,886 bytes each, equivalent to 1,138,632 bytes per minute at a 15-second interval across three tabs. The measured service peak after that refresh was 211,206,144 bytes.
- Dashboard image `f77cd81d0f1d` passed six workflow validations on its disposable guest. Separate authenticated manual and scheduled runs recorded verified delivery before cleanup. Observation image `2f5c84144afa` passed the same checks. Its default policy records 30 minutes of continuous zero growth and tracks a separate 30-minute metadata grace period. Its sampler runs every five minutes with a 15-minute continuity limit.
- Discovery image `9250d35b2a1b` fulfilled an explicit movie request with no TMDB credentials on its disposable guest. The request retained its local UUID, produced one catalog row and recorded delivery at 13:03:48.625 UTC, followed by cleanup at 13:03:49.122 UTC.
- The dashboard cutover recovery point includes a decrypt-verified credential capsule, the previous runtime and layer registration, the semantic inventory and the fingerprint of 204 persistent library entries. The previous image was `77e0cba14685` on base `a395c11ba1f3`.
- The dashboard production comparison passed for all 363 catalog rows and the library fingerprint. Live browser checks at 390 and 1,280 pixels retained the focused, selected backlog episode and its position through two real poll intervals. The dashboard-only image returned 94,893 bytes per warm poll and peaked at 211,218,432 bytes during the measured refresh.
- In the discovery guest, the installed TVmaze behavior resolved a tracked series by its IMDb alias without TMDB. Two ingestion passes retained 91 unique aired episodes and 91 unique local IDs. The latest source air date in that sample was July 26, 2026.
- Keyed rollback image `0eb1294a9de3` read the discovery appliance’s fulfilled local movie request and receipt, two TVmaze episode records, and all seven fixture switch phases. It retains the journal recovery path, disables new switches and uses serial searches.
- Production observation image `2f5c84144afa` runs commit `52a3113` on base `a395c11ba1f3`. Its pre-admission comparison passed, the VPN and egress guard passed doctor, four downloader records survived, and the native readiness check passed. The scoped encrypted rollback capsule has SHA-256 `4800ec578bc023e697e2a1a80556301b9be8c65803c2218cc18448c6632a6095`.
- With four live transfers and 363 catalog rows on that image, the first response arrived 786 ms after board restart and both snapshots were fresh after 14.44 seconds. The service peaked at 210,149,376 bytes. Three warm polls each omitted catalog rows and returned 1,281 bytes in 3.10–3.69 ms. At the same polling interval, this uses 15,372 bytes per minute across three tabs.
- The discovery guest fulfilled a movie request while TMDB was unavailable. After restoring the qualification credential, two live TMDB lookups verified IMDb tt0063350 against TMDB 10331. Both replays preserved the one catalog row, local ID, fulfilled request, library path, content hash and original receipt timestamp.
- The controlled-switch and keyless guests each passed six workflow validations and independent manual and scheduled delivery through verified receipt and cleanup. The keyed compatible reader and its layer are retained in host recovery storage. Its runtime archive has SHA-256 `57d61ffa0ae3c83662d507cd62cd0d4353fadc2f687d08e82af376d0f2ae25e7`.
- The production scheduler started the observation workflow at 13:35 UTC without a browser. Four active, metadata-ready transfers established baselines. Five minutes later, two recorded positive growth at 712 and 602 bytes per second. The other two accumulated 299 seconds of zero growth.
- On matched four-CPU qualification guests, the same synthetic movie request took 20.749 seconds from acceptance to first eligible selection on the dashboard image and 20.765 seconds on the discovery image. A separate 20-query fixture with one rate-limited provider took 3.124 seconds with serial search and 0.832 seconds with four concurrent calls and two per provider. Both modes returned one deduplicated result for each query.
- On the installed discovery image, interrupting a fixture migration after two identity writes retained both UUIDs on resume. A further replay wrote zero identities. The two active hashes and the prior delivery receipt survived. A second tracked series, Abbott Elementary, yielded 99 aired episodes from TVmaze while TMDB credentials were absent, including the November 11 episode.
- On the installed controlled image, interrupting a fixture before detachment, after detachment, or after adding the alternate produced one detach, one add and one catalog commit in each case. Recovery rejected the previous lease holder and resumed with new switches disabled. Each retained partial kept its inode and contents. The installed destination verified the library file against its receipt in each run.
- On the discovery guest, a returning TMDB episode matched the November 11 TVmaze episode on series, season, number, title and air date. It entered review. After confirming the match, two replays kept the original local UUID, one TMDB episode alias and all 99 catalog rows.
