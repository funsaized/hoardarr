# Hoardarr Strategy

## Vision
<!-- vision: author-approved 2026-11-26 -->

Hoardarr exists so you can make an autonomous movie and TV library your own.
You decide what belongs on the shelf and can give an agent the day-to-day work of tending it.
Hoardarr owns the work of turning those choices into verified files and keeping track of what each title needs next.

### A request means what it means to a viewer

You can ask for tonight's episode, the rest of a season through its finale, or every new episode of a show.
The season request ends with that season, and following a show carries into the next one.
You can close the conversation as soon as Hoardarr has the request.

Automatic movie discovery has a weekly limit by default, and you can turn the limit off.
You set which requests take priority and how much search or download capacity they can use.
Once a film arrives, its search ends until you ask for another download.

### People and agents curate through the same controls

People and curator agents use the same Hoardarr API to request a title, check its progress or resolve a problem.
New titles enter through your requests or the discovery rules you configure.
The curator can act on your request for a named film and choose which stalled title to work on next.
Picking an unrequested film on your behalf falls outside the curator's role.
You can see what it chose and why.
Swamp keeps scheduled downloads and deliveries moving when the curator is offline.

### The library works through conflicts

Each film and episode has a stable catalog entry, even when an outside source changes a title or identifier.
A provider is a tool Hoardarr uses for a particular job, such as looking up an air date or downloading a release.
When providers disagree, the engine checks the episode title, numbering and original air date against the catalog.
If a guide renumbers an episode, a second guide and a matching release can establish its identity even without a shared episode ID.
If two matches still fit, Hoardarr shows what would distinguish them and keeps working on other titles.
Fresh evidence can reopen a stalled match without waiting for someone to press retry.

### An interruption leaves work to resume

The engine handles seeding, timeouts and retries while you use the library.
A slow copy can finish while another title is being found, and two jobs touching the same files take turns.
After an unexpected shutdown, Hoardarr checks that the previous writer has stopped, reconciles the queue with the files on disk, and resumes from the last verified step.

### A delivery accounts for a file on disk

Each delivered episode has its own media file.
Hoardarr checks the destination paths, sizes and hashes and saves a receipt before removing staged files.
A conflict at the destination leaves the existing file intact.
An archive request removes only the selected local deliveries and preserves their history.

### Scope

Hoardarr records deliveries through its own API and workflow.
Importing another library tool's inventory, playing media, and making or keeping off-site archive copies fall outside its scope.
The native appliance keeps media traffic inside its VPN boundary and preserves a separate management route if the tunnel fails.
The library, catalog and downloader queue survive image replacement, and private credentials stay with the installation.

A change aligns when it helps a person or curator tend the library within the owner's rules and the owner can trace the result to a verified file or a specific unresolved decision.
A change should be resisted when it lets a request outlive its stated scope, makes an unrelated title wait for someone to clear a conflict, or puts the only good copy at risk during recovery.
