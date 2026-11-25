import "./mesh.js";
const $ = (id) => document.getElementById(id);
const views = {
  transfers: "Transfers",
  library: "Library",
  attention: "Attention",
  activity: "Activity",
};
const stages = {
  downloading: ["Downloading", "↓", "receive"],
  queued: ["Waiting", "◷", "wait"],
  seeding: ["Seeding", "↑", "send"],
};
const modes = {
  preview: ["Preview plan", "Calculate the next acquisitions and deliveries."],
  discover: ["Refresh discovery", "Refresh the catalog and tracked episode lists."],
  run: [
    "Run media pipeline",
    "Reconcile transfers, deliver ready files, and acquire eligible releases.",
  ],
};
const words = {
  wanted: "Wanted",
  selected: "Release selected",
  blocked: "Needs review",
  paused: "Paused",
  downloading: "Downloading",
  queued: "Waiting for a slot",
  seeding: "Seeding",
  transferred: "Delivered",
  "cleanup-pending": "Delivered · cleanup pending",
  "transfer-ready": "Ready for delivery",
  "seed-stopped": "Seeding complete",
  "metadata-timeout": "Waiting for release metadata",
  metadata: "Collecting release metadata",
  stall: "No recent growth",
  progress: "Receiving data",
  inactive: "Inactive",
  baseline: "First sample",
  idle: "Waiting for data",
  uncertain: "Measuring progress",
  "provider-error": "Provider unavailable",
  "authentication-error": "Provider sign-in failed",
  "no-releases": "No releases found",
  "low-seeders": "Too few seeders",
  "not-1080p-web": "Quality differs from 1080p web",
  "no-acceptable-release": "No eligible release",
  "identity-mismatch-rejected": "Identity differs",
  "title-mismatch": "Title differs",
  "year-mismatch": "Release year differs",
  "episode-token-mismatch": "Episode number differs",
  "cam-ts-tc": "Cinema recording",
  "executable-archive": "Executable archive",
  pack: "Release pack",
  "too-large": "Exceeds size limit",
  "source-not-allowed": "Source excluded",
};
const label = (value) =>
  words[value] ??
    String(value || "Unknown").replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
const when = (value) =>
  value && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";
function age(ms) {
  if (ms == null) return "no reading";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60
    ? s + "s ago"
    : s < 3600
    ? Math.floor(s / 60) + "m ago"
    : Math.floor(s / 3600) + "h ago";
}
function duration(s) {
  if (s < 60) return "<1 min";
  if (s < 3600) return Math.round(s / 60) + " min";
  if (s < 86400) return Math.round(s / 3600) + " hr";
  return Math.round(s / 86400) + " days";
}
function bytes(n) {
  if (!Number.isFinite(n)) return "";
  const i = Math.min(4, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + ["B", "KiB", "MiB", "GiB", "TiB"][i];
}
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v != null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  }
  node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}
const tag = (t, c, ...kids) => el(t, { class: c }, ...kids);
const btn = (action, text, extra = {}) =>
  el("button", { "data-action": action, type: "button", ...extra }, text);
const empty = (t) => tag("p", "empty", t);
const field = (title, ...children) =>
  tag("section", "panel", tag("div", "panel-head", tag("h2", "", title)), children);
const glyph = (word, kind) => tag("span", "glyph " + kind, word);
const keyOf = (n) => n.nodeType === 1 ? n.getAttribute("data-key") : null;
// Patch in place so a live reading cannot reset focus, text selection, scrolling, or native disclosures.
function patch(parent, children) {
  const keys = new Map(Array.from(parent.children, (n) => [keyOf(n), n]).filter(([k]) => k));
  let cursor = parent.firstChild;
  for (const next of children) {
    const key = keyOf(next);
    let old = key ? keys.get(key) : cursor;
    if (!old || old.nodeName !== next.nodeName || keyOf(old) !== key) {
      parent.insertBefore(next, cursor);
      continue;
    }
    if (old !== cursor) parent.insertBefore(old, cursor);
    if (old.nodeType === 3) { if (old.data !== next.data) old.data = next.data; }
    else {
      for (const a of [...old.attributes]) {
        if (!next.hasAttribute(a.name) && !(old.tagName === "DETAILS" && a.name === "open")) {
          old.removeAttribute(a.name);
        }
      }
      for (const a of next.attributes) {
        if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
      }
      patch(old, [...next.childNodes]);
      if (old.tagName === "SELECT" && old.value !== next.value) old.value = next.value;
      if (old.tagName === "INPUT" && old.type === "search" && old.value !== next.value) {
        old.value = next.value;
      }
    }
    cursor = old.nextSibling;
  }
  while (cursor) {
    const after = cursor.nextSibling;
    cursor.remove();
    cursor = after;
  }
}
function draw(id, ...nodes) {
  patch($(id), nodes.flat(Infinity).filter(Boolean));
}
let snapshot,
  offline = false,
  busy = false,
  mode = "preview",
  message = "",
  timer,
  lastPanel,
  historyRestore = false;
let rows = [],
  byId = new Map(),
  series = new Map(),
  incoming = [],
  review = [],
  delivered = [],
  verified = new Set(),
  seenCatalog = false;
const mobile = matchMedia("(max-width:720px)");
const params = () => new URLSearchParams(location.search);
function state() {
  const p = params();
  return {
    view: Object.hasOwn(views, p.get("view")) ? p.get("view") : "transfers",
    stage: Object.hasOwn(stages, p.get("stage")) ? p.get("stage") : "downloading",
    id: p.get("item"),
    q: p.get("q") || "",
    kind: p.get("kind") || "all",
    filter: p.get("filter") || "all",
    parent: p.get("parent"),
  };
}
function remember() {
  history.replaceState({
    ...history.state,
    y: scrollY,
    pane: $("inspector").scrollTop,
    focus: document.activeElement?.closest("[data-key]")?.dataset.key,
    open: [...$("inspector").querySelectorAll("details[open]")].map((n) => n.dataset.key),
  }, "");
}
function restore() {
  const h = history.state || {};
  for (const n of $("inspector").querySelectorAll("details")) {
    n.open = h.open?.includes(n.dataset.key) ?? n.open;
  }
  const k = h.focus;
  if (k) {
    document.querySelector('[data-key="' + CSS.escape(k) + '"]')?.focus({ preventScroll: true });
  }
  $("inspector").scrollTop = h.pane || 0;
  scrollTo(0, h.y || 0);
}
function navigate(changes, { replace = false, reset = false } = {}) {
  remember();
  const url = new URL(location.href);
  if (reset) url.search = "";
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  const from = state();
  history[replace ? "replaceState" : "pushState"](
    { from: replace ? history.state?.from : location.href },
    "",
    url,
  );
  message = "";
  render();
  if (from.id !== state().id) {
    $("inspector").scrollTop = 0;
    if (state().id) {
      $("inspector").focus({ preventScroll: true });
      if (!mobile.matches && $("inspector").getBoundingClientRect().top < 0) {
        $("inspector").scrollIntoView({ block: "nearest" });
      }
    }
  }
  if (reset) scrollTo(0, 0);
}
window.addEventListener("popstate", () => {
  render();
  restore();
});
const deliveredState = (r) => ["transferred", "cleanup-pending"].includes(r.state);
const isEpisode = (r) => r.showId != null;
const code = (r) =>
  r.season != null && r.episode != null
    ? "S" + String(r.season).padStart(2, "0") + "E" + String(r.episode).padStart(2, "0")
    : "";
const pretty = (r) => r.episodeTitle || r.title || "Untitled";
const context = (r) => [r.show, code(r)].filter(Boolean).join(" · ");
const groupId = (id) => "series:" + id;
function refreshRows() {
  const cats = snapshot.catalog.rows,
    hash = new Map(cats.filter((c) => c.hash && !c.archived).map((c) => [c.hash.toLowerCase(), c]));
  const active = new Map();
  const live = snapshot.live.rows.map((t) => {
    const c = hash.get(t.id.toLowerCase());
    const r = {
      ...c,
      ...t,
      id: String(c?.id ?? t.id),
      title: c?.title ?? t.title,
      release: t.title,
      live: true,
    };
    active.set(r.id, r);
    return r;
  });
  rows = [
    ...live,
    ...cats.filter((r) => !active.has(String(r.id))).map((r) => ({ ...r, id: String(r.id) })),
  ];
  byId = new Map(rows.map((r) => [r.id, r]));
  series = new Map(
    (snapshot.catalog.shows || []).map(
      (s) => [groupId(s.id), { id: groupId(s.id), name: s.name, episodes: [] }],
    ),
  );
  for (const c of cats) {
    if (c.review || !isEpisode(c)) continue;
    const id = groupId(c.showId);
    if (!series.has(id)) series.set(id, { id, name: c.show || "Untitled series", episodes: [] });
    series.get(id).episodes.push(byId.get(String(c.id)));
  }
  for (const s of series.values()) {
    s.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  }
  incoming = live.filter((r) => !r.archived);
  review = rows.filter((r) =>
    !r.archived &&
    (r.review || ["paused", "missing", "failed", "blocked"].includes(r.state) ||
      r.state === "wanted" &&
        ["provider-error", "authentication-error"].includes(r.search?.outcome) ||
      r.live && ["stall", "metadata-timeout"].includes(r.health?.decision))
  );
  delivered = cats.filter((r) => deliveredState(r) && r.delivered).sort((a, b) =>
    Date.parse(b.delivered) - Date.parse(a.delivered)
  );
  if (snapshot.catalog.observed) {
    const now = new Set(delivered.map((r) => r.id + "@" + r.delivered));
    if (seenCatalog && [...now].some((k) => !verified.has(k))) {
      const mark = document.querySelector(".vault-mark");
      mark.classList.remove("deposit");
      void mark.offsetWidth;
      mark.classList.add("deposit");
      $("announce").textContent = "New delivery verified.";
    }
    verified = now;
    seenCatalog = true;
  }
}
function issue(r) {
  if (
    !r.review && r.search &&
    ["authentication-error", "provider-error"].includes(r.search.outcome) &&
    ["wanted", "failed"].includes(r.state)
  ) return "Search problems";
  if (r.review) return r.reviewKind === "provider" ? "Provider problems" : "Identity decisions";
  return "Transfer problems";
}
function condition(r) {
  if (r.archived) return "Archived";
  if (r.review) return r.reviewKind === "provider" ? "Provider unavailable" : "Review needed";
  if (
    r.state === "downloading" && r.health?.decision &&
    ["stall", "metadata", "metadata-timeout", "idle"].includes(r.health.decision)
  ) return label(r.health.decision);
  if (!r.live && ["seeding", "downloading"].includes(r.state)) return "Awaiting downloader update";
  return label(r.state);
}
function nextStep(r) {
  if (r.archived) return "The catalog retains this title’s delivery record.";
  if (r.review) return r.reason || "Compare the provider records below.";
  if (deliveredState(r)) {
    return r.state === "cleanup-pending"
      ? "Delivery verified. Staging cleanup is pending."
      : "The library received this title.";
  }
  if (r.state === "wanted") {
    if (!r.search) return "No search recorded.";
    const at = r.search.nextSearchAt;
    return at
      ? (new Date(at).getTime() < Date.now() ? "Eligible since " : "Next eligible search ") +
        when(at)
      : "Waiting for an eligible release.";
  }
  if (r.releaseSwitch && !["cancelled", "committed"].includes(r.releaseSwitch.phase)) {
    return "Resume the saved release change.";
  }
  if (r.health?.decision === "stall") {
    return "The pipeline can check for an eligible alternate release.";
  }
  if (["metadata", "metadata-timeout"].includes(r.health?.decision)) {
    return "Waiting for peers to supply the release metadata.";
  }
  if (r.state === "queued") return "Waiting for an available downloader slot.";
  if (r.state === "paused") return "Inspect the downloader before resuming.";
  return r.live
    ? "The downloader is monitoring this transfer."
    : "The next pipeline run will reconcile this title.";
}
function row(
  r,
  {
    tile = false,
    title = pretty(r),
    sub,
    symbol,
    kind = "receive",
    action = "item",
    id = r.id,
    metric,
    progress,
  } = {},
) {
  const chosen = state().id === String(id);
  return btn(action, [
    glyph(symbol || "◇", kind),
    tag(
      "span",
      "rowtext",
      tag("b", "", title),
      sub && el("small", {}, sub),
      progress != null &&
        el("progress", {
          class: "meter",
          max: 100,
          value: progress,
          "aria-label": "Download progress",
        }),
    ),
    metric && tag("span", "metric", metric),
    tag("span", "arrow", "›"),
  ], {
    class: tile ? "tile" : "row",
    "data-id": id,
    "data-key": action + ":" + id,
    "aria-pressed": String(chosen),
  });
}
function transferRow(r) {
  const s = stages[r.state];
  return row(r, {
    symbol: s?.[1],
    kind: (s?.[2] || "") +
      (r.state === "downloading" && r.speed > 0 && !offline && !snapshot.live.stale
        ? " receiving"
        : ""),
    sub: [context(r), condition(r), r.rank && "Queue #" + r.rank].filter(Boolean).join(" · "),
    metric: r.progress != null ? Math.round(r.progress) + "%" : null,
    progress: r.state === "downloading" ? r.progress : null,
  });
}
function titlebar(title, n) {
  return tag("div", "view-title", tag("h2", "", title), tag("small", "", n));
}
function nav(s) {
  draw(
    "views",
    Object.entries(views).map(([id, name]) =>
      btn("view", [
        name,
        id === "attention" && Boolean(snapshot?.catalog.observed) &&
        tag("span", "count", String(review.length)),
        id === "activity" && snapshot?.operation?.status === "Running" &&
        tag("span", "count", "Live"),
      ], { "data-id": id, "data-key": id, "aria-current": s.view === id ? "page" : null })
    ),
  );
}
function transfers(s) {
  const filtered = incoming.filter((r) => r.state === s.stage).sort((a, b) =>
    (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.title.localeCompare(b.title)
  );
  draw(
    "tools",
    titlebar("Transfers", ""),
    tag(
      "div",
      "stage-grid",
      Object.entries(stages).map(([id, [name, sign, kind]]) =>
        btn("stage", [
          glyph(sign, kind),
          el("small", {}, name),
          el(
            "strong",
            {},
            snapshot.live.observed ? String(incoming.filter((r) => r.state === id).length) : "—",
          ),
        ], { "data-id": id, "aria-pressed": String(s.stage === id) })
      ),
    ),
  );
  draw(
    "results",
    field(
      stages[s.stage][0],
      filtered.length ? filtered.map(transferRow) : empty(
        snapshot.live.observed ? "No transfers in this stage." : "Waiting for the downloader.",
      ),
    ),
    tag(
      "div",
      "shelf",
      btn("wanted", "Browse wanted titles", { class: "small" }),
      btn("deliveries", "Recent deliveries", { class: "small" }),
    ),
  );
}
const isWanted = (r) =>
  !r.archived &&
  !["ignored", "seeding", "seed-stopped", "transfer-ready", "cleanup-pending", "transferred"]
    .includes(r.state);
function matchesStatus(r, f) {
  return f === "all" || (f === "wanted" && isWanted(r)) ||
    (f === "available" && !r.archived && deliveredState(r)) || (f === "archived" && r.archived);
}
const opts = (values, value) =>
  values.map(([id, name]) => el("option", { value: id, selected: id === value }, name));
function library(s) {
  const q = s.q.trim().toLowerCase();
  const cards = [];
  for (const group of [...series.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (s.kind === "movies") break;
    const eps = group.episodes.filter((r) => matchesStatus(r, s.filter));
    const match = group.name.toLowerCase().includes(q);
    if (!match || s.kind === "episodes") {
      for (const r of eps.filter((r) => (context(r) + " " + pretty(r)).toLowerCase().includes(q))) {
        cards.push(row(r, { tile: true, sub: context(r) + " · " + condition(r) }));
      }
    } else if (eps.length || s.filter === "all") {
      cards.push(
        row(group, {
          tile: true,
          sub: eps.length + " episodes · " + group.episodes.filter(isWanted).length + " remaining",
          title: group.name,
          symbol: "▤",
          kind: "send",
        }),
      );
    }
  }
  if (s.kind === "movies" || s.kind === "all") {
    for (
      const r of snapshot.catalog.rows.filter((r) =>
        !r.review && !isEpisode(r) && matchesStatus(r, s.filter) &&
        r.title?.toLowerCase().includes(q)
      ).sort((a, b) => a.title.localeCompare(b.title))
    ) cards.push(row(r, { tile: true, sub: "Movie · " + condition(r), symbol: "▸", kind: "wait" }));
  }
  draw(
    "tools",
    titlebar("Library", cards.length + " results"),
    tag(
      "div",
      "filters",
      el("input", {
        type: "search",
        id: "filter",
        placeholder: "Find a title or S02E13",
        value: s.q,
        "aria-label": "Search titles and episode numbers",
      }),
      el(
        "select",
        { id: "kind", "aria-label": "Media type" },
        opts([["all", "All media"], ["shows", "Shows"], ["movies", "Movies"], [
          "episodes",
          "Episodes",
        ]], s.kind),
      ),
    ),
    tag(
      "div",
      "chips",
      Object.entries({
        all: "All titles",
        wanted: "Wanted",
        available: "Available locally",
        archived: "Archived",
      }).map(([id, n]) =>
        btn("filter", n, { "data-id": id, "aria-pressed": String(s.filter === id) })
      ),
    ),
  );
  draw(
    "results",
    cards.length ? tag("div", "library-grid", cards) : field(
      "Library",
      empty(
        snapshot.catalog.observed ? "No titles match these filters." : "Waiting for the catalog.",
      ),
      btn("clear", "Clear filters", { class: "small" }),
    ),
  );
}
function attention() {
  draw("tools", titlebar("Attention", review.length + " items"));
  draw(
    "results",
    ["Identity decisions", "Transfer problems", "Provider problems", "Search problems"].map(
      (group) => {
        const list = review.filter((r) => issue(r) === group);
        return list.length && field(
          group,
          list.map((r) =>
            row(r, {
              sub: group === "Search problems"
                ? label(r.search?.outcome)
                : r.reason || condition(r),
              symbol: "!",
              kind: "alert",
            })
          ),
        );
      },
    ),
    !review.length &&
      field(
        "Review queue",
        empty(
          snapshot.catalog.observed ? "The review queue is clear." : "Waiting for the catalog.",
        ),
      ),
  );
}
function canOperate() {
  return snapshot?.capabilities?.operate === true &&
    !offline;
}
function activity() {
  const op = snapshot.operation || {}, running = op.status === "Running";
  const plan = snapshot.preview;
  const controls = tag(
    "div",
    "ops",
    el(
      "select",
      { id: "mode", "aria-label": "Operation" },
      opts(Object.entries(modes).map(([k, v]) => [k, v[0]]), mode),
    ),
    tag("p", "", modes[mode][1]),
    btn("execute", running ? "Operation running" : modes[mode][0], {
      class: "primary",
      disabled: !canOperate() || running || busy,
    }),
    !canOperate() && tag(
      "p",
      "notice",
      offline
        ? "Reconnect to start an operation."
        : "Commands are unavailable on this address. Open the configured private dashboard.",
    ),
    el("output", { role: "status" }, message),
  );
  draw("tools", titlebar("Activity", op.status || "Idle"));
  draw(
    "results",
    globalFeed(true),
    field("Operations", controls),
    plan &&
      field(
        "Last successful preview",
        tag("p", "", when(plan.observed)),
        [["Acquisitions", plan.acquisitions], ["Deliveries", plan.deliveries]].map(([name, ls]) =>
          el(
            "details",
            { "data-key": "plan" + name },
            el("summary", {}, name + " · " + ls.length),
            ls.length ? el("ul", {}, ls.map((t) => el("li", {}, t))) : empty("None planned."),
          )
        ),
      ),
    field(
      "Operation history",
      (snapshot.history || []).length
        ? snapshot.history.map((h) =>
          row(h, {
            action: "run-detail",
            title: modes[h.mode]?.[0] ||
              (h.mode === "resolve" ? "Item resolution" : "Series review"),
            sub: when(h.started),
            metric: h.status,
            symbol: "◷",
          })
        )
        : empty("No board operations recorded yet."),
    ),
    field(
      "Recent deliveries",
      delivered.length
        ? delivered.slice(0, 60).map((r) =>
          row(r, {
            sub: [context(r), when(r.delivered)].filter(Boolean).join(" · "),
            symbol: "✓",
            kind: "done",
          })
        )
        : empty("No deliveries recorded."),
    ),
  );
}
const feeds = new Map(), pendingFeeds = new Map();
let feedFilter = "all", feedPaused = false;
function loadFeed(key, query) {
  if (pendingFeeds.has(key) || document.hidden || feedPaused) return;
  const last = feeds.get(key);
  if (last && Date.now() - last.checked < 6500) return;
  const request = fetch("/api/feed" + query, { signal: AbortSignal.timeout(45000) }).then(
    async (res) => {
      if (!res.ok) throw Error();
      const data = await res.json();
      feeds.set(key, { ...data, checked: Date.now() });
    },
  ).catch(() =>
    feeds.set(key, {
      entries: last?.entries ?? [],
      observed: last?.observed,
      stale: true,
      checked: Date.now(),
    })
  ).finally(() => {
    pendingFeeds.delete(key);
    if (feeds.size > 64) {
      const old = [...feeds.keys()].find((k) => k !== "global" && k !== key);
      if (old) feeds.delete(old);
    }
    if (snapshot) render();
  });
  pendingFeeds.set(key, request);
}
function feedRow(e, openRun = true) {
  const title = e.item && rows.find((r) => r.key === e.item);
  const name = title ? pretty(title) : "";
  const attrs = { class: "event", "data-key": "event-" + e.id };
  const contents = [
    el(
      "time",
      { datetime: e.at, title: when(e.at) },
      e.at
        ? new Date(e.at).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
        : "—",
    ),
    tag(
      "span",
      "event-body",
      tag("small", "", e.source + (name ? " · " + name : "")),
      tag("b", "", e.label),
      e.detail && tag("small", "", e.detail),
    ),
  ];
  return e.run && openRun
    ? btn("feed-run", contents, { ...attrs, "data-id": e.run, "data-kind": e.kind ?? "workflow" })
    : el("div", attrs, contents);
}
const serviceMessages = new Map();
let source, streaming = false, repaint;
function watchSwamp() {
  if (document.hidden || feedPaused) {
    source?.close();
    source = null;
    streaming = false;
    return;
  }
  if (source) return;
  source = new EventSource("/api/feed/stream");
  source.addEventListener("entries", (e) => {
    for (const entry of JSON.parse(e.data)) serviceMessages.set(entry.id, entry);
    while (serviceMessages.size > 240) serviceMessages.delete(serviceMessages.keys().next().value);
    clearTimeout(repaint);
    repaint = setTimeout(() => {
      if (snapshot && !feedPaused) render();
    }, 80);
  });
  source.addEventListener("status", (e) => {
    const next = JSON.parse(e.data).connected;
    if (streaming !== next) {
      streaming = next;
      if (snapshot) render();
    }
  });
  source.onerror = () => {
    if (streaming) {
      streaming = false;
      if (snapshot) render();
    }
  };
}
document.addEventListener("visibilitychange", watchSwamp);
window.addEventListener("pagehide", () => {
  source?.close();
  source = null;
});
window.addEventListener("pageshow", watchSwamp);
function globalFeed(full = false) {
  loadFeed("global", "");
  const data = feeds.get("global"),
    entries = [...serviceMessages.values(), ...(data?.entries ?? [])].sort((a, b) =>
      b.at.localeCompare(a.at)
    );
  const filtered = full && feedFilter !== "all"
    ? entries.filter((e) => e.source === feedFilter)
    : entries;
  return el(
    "section",
    { class: "panel feed", "data-key": full ? "full-feed" : "rail-feed" },
    tag(
      "div",
      "panel-head",
      tag("h2", "", "Swamp feed"),
      el(
        "small",
        { class: "feed-light" },
        feedPaused
          ? "Paused"
          : data?.stale
          ? "Reconnecting"
          : streaming
          ? "Live"
          : data?.observed
          ? "History · connecting to logs"
          : "Connecting",
      ),
    ),
    full && tag(
      "div",
      "chips",
      ["all", "Workflow", "Behavior", "Step", "Log"].map((id) =>
        btn("feed-filter", id === "all" ? "All" : id, {
          "data-id": id,
          "aria-pressed": String(id === feedFilter),
        })
      ),
    ),
    tag(
      "div",
      "feed-list",
      filtered.length ? filtered.slice(0, full ? 80 : 5).map((e) => feedRow(e)) : empty(
        data?.stale
          ? "Swamp history unavailable. Reconnecting…"
          : data
          ? "No recorded events in this filter."
          : "Reading Swamp history…",
      ),
    ),
    tag(
      "div",
      "shelf",
      btn("feed-pause", feedPaused ? "Resume feed" : "Pause feed", { class: "small" }),
      !full && btn("all-events", "All activity", { class: "small" }),
    ),
  );
}
function itemTimeline(r) {
  const data = r.key ? feeds.get(r.key) : null;
  if (r.key) loadFeed(r.key, "?item=" + encodeURIComponent(r.key));
  const entries = [...(data?.entries ?? [])];
  function add(at, source, text) {
    if (at && Number.isFinite(new Date(at).getTime())) {
      entries.push({ id: source + at + text, at: new Date(at).toISOString(), source, label: text });
    }
  }
  add(r.search?.searchedAt, "Search", label(r.search?.outcome));
  for (const e of r.health?.events ?? []) add(e.at, "Downloader", label(e.decision));
  add(r.delivered, "Delivery", "Delivery verified");
  add(r.cleaned, "Staging", "Staging cleaned");
  for (const d of snapshot.catalog.decisions ?? []) {
    if (
      d.target === r.key || d.target === r.id || d.action === "link" && "e-" + d.match === r.key
    ) add(d.at, "Resolution", resolutionLabels[d.action]);
  }
  for (const run of snapshot.history ?? []) {
    if (run.subject && (run.subject === r.key || run.subject === r.id)) {
      add(run.finished ?? run.started, "Operation", run.status);
    }
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  return el(
    "div",
    { class: "detail-part", "data-key": "journey-" + r.id },
    tag("h3", "", "Item timeline"),
    data?.stale && empty("Catalog history unavailable. Retrying…"),
    entries.length
      ? tag("div", "feed-list", entries.map((e) => feedRow(e)))
      : empty(r.key && !data ? "Reading item history…" : "No recorded changes yet."),
  );
}
function executionPanel(s) {
  const [, kind, id] = s.id.split(":");
  loadFeed(s.id, "?run=" + encodeURIComponent(id) + "&kind=" + encodeURIComponent(kind));
  const data = feeds.get(s.id), track = feeds.get("global")?.entries.find((e) => e.id === id);
  const linked = data?.entries.find((e) => e.item)?.item,
    item = linked && rows.find((r) => r.key === linked);
  const entries = [...serviceMessages.values()].filter((e) => e.run === id).concat(
    data?.entries ?? [],
  ).sort((a, b) => b.at.localeCompare(a.at));
  return [
    tag("h2", "title", track?.label ?? "Swamp execution"),
    tag("p", "", track?.detail ?? kind),
    item && btn("in-library", "Open " + pretty(item), { "data-id": item.id, class: "small" }),
    tag("h3", "", "Steps and logs"),
    data?.stale && empty("Swamp history unavailable. Retrying…"),
    entries.length
      ? tag("div", "feed-list", entries.map((e) => feedRow(e, false)))
      : empty(data ? "No stored steps or log lines for this execution." : "Reading execution…"),
    el(
      "details",
      { "data-key": "run-ref" },
      el("summary", {}, "Technical details"),
      tag("p", "", id),
    ),
  ];
}
const resolutionLabels = {
  exclude: "Exclude provider episode",
  link: "Link to catalog episode",
  retry: "Retry search",
  resume: "Resume download",
  reseed: "Resume seeding",
  recheck: "Recheck transfer health",
};
function resolutionButton(action, text, c) {
  return btn("resolve-choice", text, {
    "data-id": action,
    "data-candidate": c?.id,
    class: "small",
  });
}
function resolutionPrompt(r, c) {
  if (!decision || decision.item !== r.id || decision.input.candidate !== c?.id) return null;
  return tag(
    "div",
    "answer",
    el("b", {}, decision.prompt),
    btn("do-resolve", "Confirm", { class: "primary", disabled: busy }),
    btn("cancel-resolution", "Cancel", { class: "small" }),
  );
}
let decision;

function standby() {
  const speed = incoming.reduce((s, r) => s + (r.speed || 0), 0),
    live = Boolean(speed && !offline && !snapshot.live.stale);
  const bars = Array.from({ length: 20 }, (_, i) => el("i", { class: "bar-" + i }));
  const waiting = incoming.filter((r) => r.state === "queued").sort((a, b) => a.rank - b.rank);
  return [
    field(
      "Downlink",
      tag(
        "div",
        "signal-wrap",
        tag("div", "speed", bytes(speed), el("small", {}, " /s")),
        el("div", { class: "scope " + (live ? "live" : "idle"), "aria-hidden": true }, bars),
      ),
      tag(
        "small",
        "",
        snapshot.live.stale || offline
          ? "Last known downloader reading"
          : incoming.filter((r) => r.state === "downloading").length + " downloading · " +
            incoming.filter((r) => r.state === "seeding").length + " seeding",
      ),
    ),
    state().view !== "activity" && globalFeed(),
    waiting.length > 0 &&
    field(
      "Up next",
      waiting.slice(0, 5).map((r) =>
        row(r, { action: "up-next", sub: "Queue #" + r.rank, symbol: "◷", kind: "wait" })
      ),
    ),
    field(
      "Latest delivery",
      delivered[0]
        ? row(delivered[0], { sub: when(delivered[0].delivered), symbol: "✓", kind: "done" })
        : empty("No deliveries recorded."),
    ),
  ];
}
function facts(pairs) {
  const valid = pairs.filter(([, v]) => v !== undefined && v !== null && v !== "");
  return valid.length
    ? tag("dl", "facts", valid.map(([k, v]) => [el("dt", {}, k), el("dd", {}, String(v))]))
    : null;
}
function seriesContents(g, s) {
  const seasons = new Map();
  for (const r of g.episodes.filter((r) => matchesStatus(r, s.filter))) {
    if (!seasons.has(r.season)) seasons.set(r.season, []);
    seasons.get(r.season).push(r);
  }
  return [
    tag("h2", "title", g.name),
    tag("p", "", g.episodes.length + " cataloged episodes"),
    [...seasons].map(([season, eps]) =>
      el(
        "details",
        { "data-key": "season:" + season },
        el("summary", {}, "Season " + (season ?? "unknown") + " · " + eps.length + " episodes"),
        eps.map((r) => row(r, { sub: code(r) + " · " + condition(r), action: "episode" })),
      )
    ),
  ];
}
function candidate(c, r) {
  return tag(
    "div",
    "candidate",
    el("b", {}, c.name || "Name unavailable"),
    el("small", {}, [c.provider, c.kind, c.number, c.date].filter(Boolean).join(" · ")),
    c.note && tag("p", "", c.note),
    c.url && el("a", { href: c.url }, "Provider record ↗"),
    c.revision && c.kind === "episode" && /^review-tracked-/.test(r.id) && canOperate() &&
      [
        c.match && resolutionButton("link", "Link to " + c.match.title, c),
        resolutionButton("exclude", "Exclude this episode", c),
        resolutionPrompt(r, c),
      ],
    r.canConfirm && canOperate() &&
      btn("choose", "Review this match", { class: "small", "data-id": c.id }),
  );
}
let proposed;
function itemContents(r) {
  const h = r.health || {}, search = r.search || {}, sw = r.releaseSwitch || {};
  const reason = r.reason?.split(", ").map((v) => words[v] || v).join(" · ");
  const details = [
    ["Catalog reference", r.id],
    ["Swamp item key", r.key],
    ["Search revision", search.searchedAt],
    ["Release", r.release],
    ["Transfer hash", r.hash],
    ["Previous hash", sw.oldHash],
    ["Alternate hash", sw.newHash],
    ["Alternate rank", sw.rank],
    ["Raw state", r.state],
    [
      "Provider references",
      r.candidates?.map((c) => c.provider + " " + c.id).join(", ") || r.providers,
    ],
  ];
  return [
    tag("h2", "title", pretty(r)),
    tag("p", "", context(r) || (!r.review && r.year ? String(r.year) : "")),
    tag("div", "answer", el("b", {}, condition(r)), tag("p", "", nextStep(r))),
    r.key && r.live && ["stall", "metadata-timeout"].includes(h.decision) && canOperate() &&
    resolutionButton("recheck", "Recheck transfer health"),
    r.state === "paused" && r.key && canOperate() &&
    resolutionButton(r.seed ? "reseed" : "resume", r.seed ? "Resume seeding" : "Resume download"),
    r.key && ["wanted", "failed"].includes(r.state) &&
    ["authentication-error", "provider-error", "no-match", "no-releases"].includes(
      search.outcome,
    ) && canOperate() &&
    [
      search.outcome === "authentication-error" &&
      tag("p", "", "Update the provider credential before retrying."),
      resolutionButton("retry", "Retry search"),
    ],
    resolutionPrompt(r),
    r.candidates?.length > 0 &&
    tag(
      "div",
      "detail-part",
      el("h3", {}, "Provider records"),
      r.candidates.map((c) => candidate(c, r)),
    ),
    itemTimeline(r),
    facts([
      ["Progress", r.progress != null ? r.progress + "%" : null],
      [
        "Downloaded",
        r.bytes != null ? bytes(r.bytes) + (r.total ? " / " + bytes(r.total) : "") : null,
      ],
      ["Live speed", r.speed != null ? bytes(r.speed) + "/s" : null],
      ["Peers", r.peers],
      ["Queue position", r.rank],
      ["Metadata wait", h.metadataMs != null ? duration(h.metadataMs / 1000) : null],
      ["Without growth", h.idleMs != null ? duration(h.idleMs / 1000) : null],
      ["Measured growth", h.byteRate != null ? bytes(h.byteRate) + "/s" : null],
      [
        "Estimated time",
        r.state === "downloading"
          ? (h.decision === "progress" && r.speed > 0 && h.etaSeconds > 0 &&
              h.etaSeconds < 30 * 86400
            ? duration(h.etaSeconds)
            : "Estimating")
          : null,
      ],
      ["Last growth", when(h.lastProgressAt)],
      ["Health sample", when(h.observedAt)],
      [
        "Search outcome",
        search.outcome && label(search.outcome) + (search.partial ? " · partial response" : ""),
      ],
      ["Eligible releases", search.rankedCount],
      ["Last successful search", when(search.lastSuccessfulAt)],
      ["Release change", sw.phase && label(sw.phase)],
      ["Verified delivery", when(r.delivered)],
      ["Staging cleanup", when(r.cleaned)],
      ["Search details", r.review ? null : reason],
      ["Observed", age(r.live ? snapshot.live.observed : snapshot.catalog.observed)],
    ]),
    proposed?.review === r.id &&
    tag(
      "div",
      "answer",
      el("b", {}, "Confirm " + proposed.name + "?"),
      tag("p", "", "Future discovery will use this TVmaze series for " + r.title + "."),
      btn("confirm", "Confirm series match", { class: "primary", disabled: busy }),
      btn("cancel", "Cancel", { class: "small" }),
    ),
    message && el("output", { role: "status" }, message),
    r.sourceUrl && /^https:\/\/www\.tvmaze\.com\/shows\/\d+$/.test(r.sourceUrl) &&
    el("a", { class: "source", href: r.sourceUrl }, r.source + " ↗"),
    h.events?.length > 0 &&
    el(
      "details",
      { "data-key": "samples" },
      el("summary", {}, "Observation history"),
      tag(
        "ul",
        "timeline",
        h.events.map((e) => el("li", {}, when(e.at) + " · " + label(e.decision))),
      ),
    ),
    el(
      "details",
      { "data-key": "tech" },
      el("summary", {}, "Technical details"),
      facts(details),
      btn("copy", "Copy references", { class: "small" }),
    ),
    !r.review && r.live !== true && state().view !== "library" &&
    btn("in-library", "View in library", { class: "small" }),
  ];
}
function inspector(s) {
  const g = series.get(s.id),
    r = byId.get(s.id),
    run = (snapshot.history || []).find((h) => h.id === s.id);
  const panel = $("inspector");
  if (!s.id) draw("inspector", standby());
  else {draw(
      "inspector",
      el(
        "section",
        { "data-key": "inspect:" + s.id },
        tag(
          "div",
          "detail-head",
          tag(
            "span",
            "kicker",
            g
              ? "Tracked series"
              : r?.review
              ? "Attention"
              : run
              ? "Operation"
              : isEpisode(r || {})
              ? "Episode"
              : "Title",
          ),
          btn("close", "← Back", { class: "small" }),
        ),
        s.id.startsWith("swamp:")
          ? executionPanel(s)
          : g
          ? seriesContents(g, s)
          : r
          ? itemContents(r)
          : run
          ? [
            tag(
              "h2",
              "title",
              modes[run.mode]?.[0] ||
                (run.mode === "resolve" ? "Item resolution" : "Series review"),
            ),
            facts([
              ["Status", run.status],
              ["Started", when(run.started)],
              ["Finished", when(run.finished)],
              ["Operation ID", run.id],
              ["Swamp run", run.runId],
            ]),
          ]
          : empty(
            snapshot.catalog.observed
              ? "This item is no longer in the current catalog."
              : "Loading this item…",
          ),
      ),
      !mobile.matches && s.view !== "activity" && globalFeed(),
    );}
  if (s.id !== lastPanel) {
    panel.firstElementChild?.classList.add("inspect-enter");
    lastPanel = s.id;
  }
  const modal = Boolean(s.id && mobile.matches);
  document.body.classList.toggle("inspecting", modal);
  for (const n of document.querySelectorAll("header,.horizon,#views,#listing,footer")) {
    n.inert = modal;
  }
  if (modal) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
  } else {
    panel.removeAttribute("role");
    panel.removeAttribute("aria-modal");
  }
}
let listStamp;
function render() {
  const s = state();
  nav(s);
  if (!snapshot) {
    draw("tools", titlebar(views[s.view], ""));
    draw("results", empty(offline ? "Board unavailable. Reconnecting…" : "Tuning in…"));
    return;
  }
  const stamp = JSON.stringify([s, snapshot.catalog.revision, snapshot.catalog.observed]);
  if (s.view !== "library" || stamp !== listStamp) {
    ({ transfers, attention, library, activity }[s.view])(s);
  }
  listStamp = stamp;
  inspector(s);
  freshness();
  if (historyRestore && (!s.id || snapshot.catalog.observed)) {
    restore();
    historyRestore = false;
  }
}
function freshness() {
  if (!snapshot) return;
  const health = $("health");
  const stale = offline || snapshot.catalog.stale || snapshot.live.stale;
  health.textContent = offline
    ? "Connection lost"
    : !snapshot.catalog.observed
    ? "Loading catalog"
    : stale
    ? "Partial · stale data"
    : "Connected";
  health.classList.toggle("stale", stale);
  for (const [id, r] of [["torlink", snapshot.live], ["catalog", snapshot.catalog]]) {
    $(id).textContent = (id === "catalog" ? "Catalog" : "Downloader") + " · " +
      (r.stale || offline ? "stale · " : "") + age(r.observed);
  }
}
let updating;
async function update() {
  clearTimeout(timer);
  if (updating) return updating;
  updating = (async () => {
    try {
      const url = new URL("/api/board", location.href);
      if (snapshot?.catalog.revision) url.searchParams.set("catalog", snapshot.catalog.revision);
      const response = await fetch(url, { signal: AbortSignal.timeout(55000) });
      if (!response.ok) throw Error();
      const board = await response.json();
      if (!("rows" in board.catalog)) {
        board.catalog.rows = snapshot.catalog.rows;
        board.catalog.shows = snapshot.catalog.shows;
        board.catalog.decisions = snapshot.catalog.decisions;
      }
      snapshot = board;
      offline = false;
      refreshRows();
    } catch {
      offline = true;
      if (!snapshot) $("health").textContent = "Board unavailable";
    } finally {
      render();
      updating = null;
      if (!document.hidden) {
        timer = setTimeout(
          update,
          offline || snapshot?.operation?.status === "Running" || incoming.some((r) =>
              r.state !== "seeding"
            ) ||
            snapshot?.catalog.stale
            ? 15000
            : 60000,
        );
      }
    }
  })();
  return updating;
}
async function operate(which, payload) {
  if (!canOperate() || busy) return;
  busy = true;
  message = "Starting…";
  render();
  try {
    const res = await fetch("/api/operate/" + which, {
      method: "POST",
      ...(payload
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        : {}),
    });
    message = res.ok
      ? "Operation accepted."
      : res.status === 409
      ? "Another operation or review update took precedence. Refresh and check its status."
      : res.status === 403
      ? "Open the configured private dashboard."
      : "Operation unavailable.";
    if (res.ok) {
      snapshot.operation = await res.json();
      proposed = null;
    }
  } catch {
    message = "Connection lost. Check Activity before retrying.";
  } finally {
    busy = false;
    render();
    await update();
  }
}
function closePanel() {
  const s = state();
  proposed = null;
  if (history.state?.from && new URL(history.state.from).origin === location.origin) history.back();
  else navigate({ item: s.parent, parent: null }, { replace: true });
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("button[data-action]");
  if (!b) return;
  const a = b.dataset.action, id = b.dataset.id, s = state();
  if (a !== "choose" && a !== "confirm") proposed = null;
  if (!["do-resolve", "resolve-choice"].includes(a)) decision = null;
  switch (a) {
    case "resolve-choice": {
      const r = byId.get(s.id),
        c = r?.candidates?.find((c) => String(c.id) === b.dataset.candidate);
      if (!r) return;
      const input = {
        action: id,
        target: c ? r.id : r.key,
        revision: c?.revision ?? (id === "retry" ? r.search?.searchedAt : r.hash ?? r.id),
        ...(c ? { candidate: c.id } : {}),
        ...(id === "link" ? { match: c.match.id } : {}),
      };
      decision = {
        item: r.id,
        input,
        prompt: id === "link"
          ? "Identify " + c.name + " as " + c.match.title + " at " + c.number + "?"
          : id === "exclude"
          ? "Exclude " + c.name + " from this review while its provider details stay the same?"
          : id === "retry"
          ? "Make " + pretty(r) + " eligible for search on the next acquisition run?"
          : resolutionLabels[id] + " for " + pretty(r) + "?",
      };
      render();
      break;
    }
    case "cancel-resolution":
      decision = null;
      render();
      break;
    case "do-resolve":
      if (decision) {
        const input = decision.input;
        decision = null;
        await operate("resolve", input);
      }
      break;
    case "all-events":
      navigate({ view: "activity" }, { reset: true });
      break;
    case "feed-filter":
      feedFilter = id;
      render();
      break;
    case "feed-pause":
      feedPaused = !feedPaused;
      watchSwamp();
      render();
      break;
    case "feed-run":
      navigate({ item: "swamp:" + b.dataset.kind + ":" + id, parent: s.id });
      break;
    case "view":
      navigate({ view: id }, { reset: true });
      break;
    case "stage":
      navigate({ stage: id, item: null });
      break;
    case "wanted":
      navigate({ view: "library", filter: "wanted" }, { reset: true });
      break;
    case "deliveries":
      navigate({ view: "activity" }, { reset: true });
      break;
    case "filter":
      navigate({ filter: id, item: null, parent: null });
      break;
    case "clear":
      navigate({ view: "library" }, { reset: true });
      break;
    case "item":
    case "run-detail":
      navigate({ item: id, parent: null });
      break;
    case "episode":
      navigate({ item: id, parent: s.id });
      break;
    case "up-next":
      navigate({ view: "transfers", stage: "queued", item: id }, { reset: true });
      break;
    case "close":
      closePanel();
      break;
    case "in-library":
      navigate({ view: "library", item: id || s.id }, { reset: true });
      break;
    case "execute":
      await operate(mode);
      break;
    case "choose": {
      const r = byId.get(s.id), c = r.candidates.find((c) => String(c.id) === id);
      proposed = { review: r.id, name: c.name, id: c.id, revision: r.reviewRevision };
      render();
      break;
    }
    case "confirm":
      if (proposed) {
        await operate("confirm", {
          review: proposed.review,
          id: proposed.id,
          revision: proposed.revision,
        });
      }
      break;
    case "cancel":
      proposed = null;
      render();
      break;
    case "copy":
      try {
        await navigator.clipboard.writeText(b.closest("details").querySelector("dl").innerText);
        $("announce").textContent = "References copied.";
        b.textContent = "Copied";
      } catch {
        $("announce").textContent = "Select the references to copy them.";
      }
      break;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "filter") navigate({ q: e.target.value, item: null }, { replace: true });
});
document.addEventListener("change", (e) => {
  if (e.target.id === "kind") navigate({ kind: e.target.value, item: null });
  if (e.target.id === "mode") {
    mode = e.target.value;
    render();
  }
});
document.addEventListener("keydown", (e) => {
  if (!state().id) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closePanel();
  }
  if (e.key === "Tab" && mobile.matches) {
    const focusable = [...$("inspector").querySelectorAll("button:not(:disabled),a,summary")]
      .filter((n) => n.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (
      e.shiftKey && (document.activeElement === first || document.activeElement === $("inspector"))
    ) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});
mobile.addEventListener("change", render);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else update();
});
window.addEventListener("pagehide", remember);
historyRestore = Boolean(history.state);
render();
update();
setInterval(freshness, 5000);

setInterval(() => {
  if (!document.hidden && snapshot && !feedPaused) render();
}, 7000);
