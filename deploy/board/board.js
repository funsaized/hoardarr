const byId = (id) => document.getElementById(id);
const stages = ["Waiting", "Downloading", "Seeding", "Delivered today", "Backlog", "Attention"];
let current = "Downloading", selected, snapshot, timer, loading = false, offline = false;
const minutes = (stamp) =>
  stamp ? Math.max(0, Math.floor((Date.now() - stamp) / 1000)) + "s ago" : "no reading";
function element(tag, text, cls) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function size(n) {
  if (!Number.isFinite(n)) return "";
  const i = Math.min(4, Math.floor(Math.log(Math.max(n, 1)) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + ["B", "KiB", "MiB", "GiB", "TiB"][i];
}
function describe(r, includeState = true) {
  return [
    r.rank && "#" + r.rank,
    includeState && r.state,
    r.progress != null && r.progress + "%",
    r.speed != null && size(r.speed) + "/s",
    r.bytes != null && size(r.bytes) + (r.total ? " / " + size(r.total) : ""),
    r.eta > 0 && "~" + Math.ceil(r.eta / 60) + "m left",
  ].filter(Boolean).join(" · ");
}
function group(r) {
  if (r.state === "transferred" || r.state === "cleanup-pending") return "Delivered today";
  if (r.state === "downloading") return "Downloading";
  if (r.state === "seeding") return "Seeding";
  if (r.state === "queued") return "Waiting";
  if (["paused", "missing", "failed", "blocked"].includes(r.state)) return "Attention";
  return "Backlog";
}
const symbols = {
  Waiting: ["◷", "wait"], Downloading: ["↓", "receive"], Seeding: ["↑", "send"],
  "Delivered today": ["✓", "done"], Backlog: ["▤", "stack"], Attention: ["!", "alert"],
};
function icon(stage, index = 0) {
  const [glyph, motion] = symbols[stage];
  const node = element("span", glyph, "signal " + motion + " phase-" + (index % 4));
  node.setAttribute("aria-hidden", "true");
  return node;
}
const expandedBacklog = new Set();
function freshness() {
  if (!snapshot) return;
  for (const [id, s] of [["torlink", snapshot.live], ["catalog", snapshot.catalog]]) {
    const node = byId(id);
    node.textContent = (id === "torlink" ? "Torlink" : "Catalog") + " · " +
      (s.stale || offline ? "stale · " : "") + minutes(s.observed);
    node.classList.toggle("stale", s.stale || offline);
  }
}
function render() {
  if (!snapshot) return;
  const { live, catalog } = snapshot;
  const activeCatalog = catalog.rows.filter((r) => !r.archived);
  const byHash = new Map(activeCatalog.filter((r) => r.hash).map((r) => [r.hash.toLowerCase(), r]));
  const joined = new Set();
  const rows = live.rows.map((t) => {
    const c = byHash.get(t.id.toLowerCase());
    if (c) joined.add(c.id);
    return { ...t, id: c?.id ?? t.id, title: c?.title ?? t.title, release: t.title };
  });
  rows.push(
    ...activeCatalog.filter((c) => !joined.has(c.id)).map((c) => ({
      ...c,
      state: ["downloading", "seeding"].includes(c.state)
        ? "awaiting downloader observation"
        : c.state,
    })),
  );
  const today = new Date().toDateString();
  const groups = new Map(stages.map((s) => [s, []]));
  for (const row of rows) {
    const stage = group(row);
    if (stage === "Delivered today" && new Date(row.delivered).toDateString() !== today) continue;
    groups.get(stage).push(row);
  }
  for (const list of groups.values()) {
    list.sort((a, b) =>
      (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    );
  }
  const unknown = (s) =>
    ["Waiting", "Downloading", "Seeding"].includes(s) ? !live.observed : !catalog.observed;
  byId("health").textContent = offline
    ? "Connection lost"
    : !catalog.observed && catalog.refreshing
    ? "Loading catalog"
    : live.stale || catalog.stale
    ? "Partial · stale data"
    : "●  Connected";
  byId("health").classList.toggle("stale", offline || live.stale || catalog.stale);
  if (!groups.get(current).some((r) => r.id === selected)) selected = undefined;
  stages.forEach((s, i) => {
    const b = byId("stages").children[i];
    b.lastChild.textContent = unknown(s) ? "—" : groups.get(s).length;
    b.setAttribute("aria-pressed", s === current);
  });
  function list(node, items, empty) {
    const previous = node.contains(document.activeElement) && document.activeElement.dataset.id;
    node.replaceChildren();
    for (const [index, r] of items.entries()) {
      const b = element("button", "", "row");
      b.dataset.id = r.id;
      b.setAttribute("aria-pressed", r.id === selected);
      const title = element("b", "", "item-title");
      const receiving = r.speed > 0 && !live.stale && !offline;
      const signal = icon(group(r), index);
      signal.classList.toggle("stationary", r.state === "downloading" && !receiving);
      title.append(signal, document.createTextNode(r.title));
      const hasMeter = r.state === "downloading" && Number.isFinite(r.progress);
      b.append(title, element("span", describe(r, !hasMeter), "meta"));
      if (hasMeter) {
        const percent = Math.max(0, Math.min(100, r.progress));
        const meter = element("span", "", "download-meter");
        meter.style.setProperty("--complete", percent + "%");
        meter.classList.toggle("flowing", receiving);
        meter.setAttribute("role", "progressbar");
        meter.setAttribute("aria-label", "Downloading " + r.title);
        meter.setAttribute("aria-valuenow", String(percent));
        const label = element("span", "Downloading", "meter-word");
        label.setAttribute("aria-hidden", "true");
        const rail = element("span", "", "meter-rail");
        rail.append(element("span", "", "meter-fill"));
        meter.append(label, rail);
        b.append(meter);
      }
      b.onclick = () => {
        if (node.id === "next") current = "Waiting";
        selected = selected === r.id ? undefined : r.id;
        render();
      };
      node.append(b);
      if (previous === r.id) b.focus({ preventScroll: true });
    }
    if (!items.length) node.append(element("p", empty, "empty"));
  }
  byId("group").textContent = current;
  const items = byId("items");
  if (current === "Backlog" && groups.get(current).length) {
    const focus = items.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    const scroll = items.scrollTop;
    const buckets = new Map();
    for (const row of groups.get(current)) {
      const id = row.showId ? "show-" + row.showId : "movies";
      if (!buckets.has(id)) buckets.set(id, { label: row.show || "Movies", rows: [] });
      buckets.get(id).rows.push(row);
    }
    items.replaceChildren();
    for (const [id, bucket] of buckets) {
      const details = element("details", "", "series backlog");
      const summary = element("summary", "");
      summary.dataset.id = id;
      const ordered = bucket.rows.sort((a, b) => a.season - b.season || a.episode - b.episode);
      const next = ordered[0];
      summary.append(
        icon("Backlog", items.childElementCount),
        element("b", bucket.label),
        element("span", ordered.length + " outstanding", "meta"),
      );
      const body = element("div", "");
      const fill = () => {
        if (!details.open || body.childElementCount) return;
        if (next.season == null || ordered.length <= 12) {
          list(body, ordered, "");
          return;
        }
        const seasons = new Map();
        for (const row of ordered) {
          if (!seasons.has(row.season)) seasons.set(row.season, []);
          seasons.get(row.season).push(row);
        }
        for (const [season, episodes] of seasons) {
          const seasonId = id + "-season-" + season;
          const section = element("details", "", "series");
          const heading = element("summary", "Season " + season + " · " + episodes.length);
          heading.dataset.id = seasonId;
          const entries = element("div", "");
          section.append(heading, entries);
          section.open = expandedBacklog.has(seasonId);
          if (section.open) list(entries, episodes, "");
          section.ontoggle = () => {
            if (!section.isConnected) return;
            if (section.open) {
              expandedBacklog.add(seasonId);
              if (!entries.childElementCount) list(entries, episodes, "");
            } else expandedBacklog.delete(seasonId);
          };
          body.append(section);
        }
      };
      details.append(summary, body);
      details.open = expandedBacklog.has(id);
      fill();
      details.ontoggle = () => {
        if (!details.isConnected) return;
        if (details.open) expandedBacklog.add(id);
        else expandedBacklog.delete(id);
        fill();
      };
      items.append(details);
    }
    if (focus) items.querySelector('[data-id="' + CSS.escape(focus) + '"]')?.focus({ preventScroll: true });
    items.scrollTop = scroll;
  } else {
    list(items, groups.get(current), unknown(current) ? "Waiting for a reading." : "No items in this stage.");
  }
  list(
    byId("next"),
    groups.get("Waiting").slice(0, 5),
    !live.observed ? "Waiting for Torlink." : "No transfers waiting for a slot.",
  );
  const item = rows.find((r) => r.id === selected);
  const detail = byId("detail");
  detail.hidden = !item;
  if (item) {
    detail.querySelector("h3").textContent = item.title;
    const dl = detail.querySelector("dl");
    dl.replaceChildren();
    for (
      const [k, v] of Object.entries({
        State: describe(item),
        Release: item.release,
        Peers: item.peers,
        Reason: item.reason,
        Delivered: item.delivered,
        Observed: minutes(item.release ? live.observed : catalog.observed),
      })
    ) {
      if (v != null) dl.append(element("dt", k), element("dd", String(v)));
    }
  }
  renderPreview(snapshot.preview);
  const op = snapshot.operation;
  byId("operation").textContent = op?.mode ? modes[op.mode].label + " · " + op.status : "Idle";
  byId("execute").disabled = offline || !op || op.status === "Running";
  if (!byId("library").hidden) library();
  freshness();
}
for (const stage of stages) {
  const b = element("button", "");
  b.append(icon(stage), element("small", stage), element("strong", "—"));
  b.onclick = () => {
    selected = undefined;
    current = stage;
    render();
  };
  byId("stages").append(b);
}
const modes = {
  preview: {
    label: "Preview plan",
    button: "Start preview",
    help: "Calculate the next media plan from the saved catalog.",
  },
  discover: {
    label: "Refresh discovery",
    button: "Refresh catalog",
    help: "Discover media and update the catalog without starting downloads.",
  },
  run: {
    label: "Run media pipeline",
    button: "Start media run",
    help: "Reconcile transfers, deliver ready files and acquire eligible releases.",
  },
};
function modeChanged() {
  const mode = modes[byId("commands").elements.workflow.value];
  byId("mode-help").textContent = mode.help;
  byId("execute").textContent = mode.button;
}
byId("mode").onchange = modeChanged;
modeChanged();
byId("commands").onsubmit = async (event) => {
  event.preventDefault();
  const button = byId("execute");
  button.disabled = true;
  try {
    const mode = byId("commands").elements.workflow.value;
    const res = await fetch("/api/operate/" + mode, {
      method: "POST",
      headers: { Authorization: "Bearer " + byId("key").value.trim() },
    });
    byId("feedback").textContent = res.ok
      ? modes[mode].label + " accepted."
      : res.status === 403
      ? "Operator key rejected."
      : res.status === 409
      ? "Another operation is running."
      : "Operation unavailable.";
    if (res.ok) snapshot.operation = await res.json();
  } catch {
    byId("feedback").textContent = "Connection lost. Check operation status before retrying.";
  }
  render();
  await update();
};
for (const button of byId("views").children) {
  button.onclick = () => {
    const heading = document.querySelector(".horizon h1");
    const isLibrary = button.dataset.view === "library";
    heading.replaceChildren(document.createTextNode(isLibrary ? "Tracked " : "Transfer "), element("em", isLibrary ? "library" : "deck"));
    for (const other of byId("views").children) {
      const active = other === button;
      other.setAttribute("aria-pressed", active);
      byId(other.dataset.view).hidden = !active;
    }
    selected = undefined;
    render();
  };
}
function renderPreview(plan) {
  byId("preview").hidden = !plan;
  if (!plan) return;
  byId("preview-time").textContent = "Catalog plan recorded " +
    new Date(plan.observed).toLocaleString();
  const groups = byId("plan-groups");
  groups.replaceChildren();
  if (!plan.acquisitions.length && !plan.deliveries.length) {
    groups.append(
      element("p", "No acquisitions or deliveries are planned from this catalog reading."),
    );
    return;
  }
  for (
    const [label, titles] of [["Acquisitions", plan.acquisitions], ["Deliveries", plan.deliveries]]
  ) {
    const column = element("div", "");
    column.append(element("h3", label + " · " + titles.length));
    const list = element("ul", "");
    for (const title of titles) list.append(element("li", title));
    column.append(list);
    groups.append(column);
  }
}
const remainingButton = byId("remaining");
const expandedSeries = new Set();
const collapsedRemaining = new Set();
remainingButton.onclick = () => {
  remainingButton.setAttribute(
    "aria-pressed",
    remainingButton.getAttribute("aria-pressed") !== "true",
  );
  library();
};
function library() {
  const { rows, shows, observed } = snapshot.catalog;
  const titles = byId("titles");
  const focused = document.activeElement.closest("#titles details")?.dataset.id;
  titles.replaceChildren();
  const series = new Map((shows ?? []).map((s) => [s.id, { name: s.name, episodes: [] }]));
  const movies = [];
  const downloaded = (r) =>
    ["seeding", "seed-stopped", "transfer-ready", "cleanup-pending", "transferred"].includes(
      r.state,
    );
  const remaining = (r) => !downloaded(r) && !r.archived && r.state !== "ignored";
  let total = 0, done = 0, left = 0;
  for (const r of rows) {
    if (!r.showId) {
      movies.push(r);
      continue;
    }
    if (!series.has(r.showId)) series.set(r.showId, { name: r.show, episodes: [] });
    series.get(r.showId).episodes.push(r);
    total++;
    if (downloaded(r)) done++;
    if (remaining(r)) left++;
  }
  remainingButton.hidden = !observed;
  remainingButton.textContent = left + " remaining";
  const onlyRemaining = remainingButton.getAttribute("aria-pressed") === "true";
  byId("totals").textContent = observed
    ? series.size + " shows  /  " + movies.length + " movies  /  " + total +
      " known episodes  /  " + done + " downloaded  /  "
    : "Waiting for catalog.";
  const query = byId("filter").value.trim().toLowerCase();
  for (const [id, show] of [...series].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    if (!show.name.toLowerCase().includes(query)) continue;
    const eps = show.episodes;
    const visible = onlyRemaining ? eps.filter(remaining) : eps;
    if (!visible.length && onlyRemaining) continue;
    const d = element("details", "", "series");
    d.dataset.id = String(id);
    const summary = element("summary", "");
    summary.append(
      element("b", show.name),
      element(
        "span",
        eps.length
          ? eps.filter(downloaded).length + "/" + eps.length + " downloaded · " +
            eps.filter(remaining).length + " remaining"
          : "No known episodes",
        "meta",
      ),
    );
    d.append(summary);
    const fill = () => {
      if (!d.open || d.children.length > 1) return;
      const episodes = element("div", "", "library-episodes");
      for (const ep of visible.sort((a, b) => a.season - b.season || a.episode - b.episode)) {
        const line = element("div", "", "episode");
        line.append(
          element(
            "b",
            "S" + String(ep.season).padStart(2, "0") + "E" + String(ep.episode).padStart(2, "0"),
          ),
          element("span", ep.episodeTitle || "Untitled episode"),
          element("small", ep.archived ? "archived" : ep.state),
        );
        episodes.append(line);
      }
      d.append(episodes);
    };
    d.open = onlyRemaining ? !collapsedRemaining.has(id) : expandedSeries.has(id);
    fill();
    d.ontoggle = () => {
      if (!d.isConnected) return;
      if (onlyRemaining) {
        if (d.open) collapsedRemaining.delete(id);
        else collapsedRemaining.add(id);
      } else if (d.open) expandedSeries.add(id);
      else expandedSeries.delete(id);
      fill();
    };
    titles.append(d);
    if (focused === String(id)) summary.focus({ preventScroll: true });
  }
  for (const m of (onlyRemaining ? [] : movies).sort((a, b) => a.title.localeCompare(b.title))) {
    if (!m.title.toLowerCase().includes(query)) continue;
    const div = element("div", "", "movie");
    div.append(
      element("b", m.title),
      element("span", "Movie · " + (m.archived ? "archived" : m.state), "meta"),
    );
    titles.append(div);
  }
  if (observed && !titles.children.length) {
    titles.append(
      element(
        "p",
        query
          ? "No matching titles."
          : onlyRemaining
          ? "No remaining episodes."
          : "No tracked titles yet.",
        "empty",
      ),
    );
  }
}
byId("filter").oninput = () => {
  if (snapshot) library();
};
async function update() {
  clearTimeout(timer);
  if (document.hidden || loading) return;
  loading = true;
  try {
    const url = new URL("/api/board", location.href);
    if (snapshot?.catalog.revision) url.searchParams.set("catalog", snapshot.catalog.revision);
    const r = await fetch(url, { signal: AbortSignal.timeout(55000) });
    if (!r.ok) throw Error();
    const updated = await r.json();
    if (!("rows" in updated.catalog)) {
      updated.catalog.rows = snapshot.catalog.rows;
      updated.catalog.shows = snapshot.catalog.shows;
    }
    snapshot = updated;
    offline = false;
    render();
  } catch {
    offline = true;
    if (snapshot) render();
    else byId("health").textContent = "Board unavailable · retrying";
  } finally {
    loading = false;
    const fast = snapshot?.operation?.status === "Running" || offline || snapshot?.live.stale ||
      snapshot?.catalog.stale ||
      snapshot?.live.rows.some((r) => ["queued", "downloading"].includes(r.state));
    if (!document.hidden) timer = setTimeout(update, fast ? 15000 : 60000);
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else update();
});
setInterval(freshness, 5000);
update();

// Draw on demand. Pointer movement bends the lattice and releases it back into place.
function mountMesh(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const radius = 106;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let width, height, frame = 0, strength = 0, target = 0;
  let x = 0, y = 0, aimX = 0, aimY = 0;
  function schedule() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function draw() {
    frame = 0;
    x += (aimX - x) * .28;
    y += (aimY - y) * .28;
    strength += (target - strength) * .16;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(140,106,207,.24)";
    if (strength > .01) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, "rgba(99,255,241," + strength + ")");
      glow.addColorStop(.52, "rgba(246,92,208," + (.78 * strength) + ")");
      glow.addColorStop(1, "rgba(140,106,207,.24)");
      ctx.strokeStyle = glow;
    }
    ctx.beginPath();
    function vertex(px, py, first) {
      const dx = px - x, dy = py - y;
      const influence = Math.max(0, 1 - (dx * dx + dy * dy) / (radius * radius));
      const warp = influence * influence * strength * .65;
      if (first) ctx.moveTo(px + dx * warp, py + dy * warp);
      else ctx.lineTo(px + dx * warp, py + dy * warp);
    }
    for (let col = 0; col <= width; col += 40) {
      for (let row = 0; row <= height + 10; row += 10) vertex(col, row, row === 0);
    }
    for (let row = 0; row <= height; row += 40) {
      for (let col = 0; col <= width + 10; col += 10) vertex(col, row, col === 0);
    }
    ctx.stroke();
    if (Math.abs(strength - target) > .002 || Math.abs(x - aimX) + Math.abs(y - aimY) > .5) schedule();
  }
  function resize() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    const scale = Math.min(devicePixelRatio, 1.5);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    schedule();
  }
  function release() { target = 0; schedule(); }
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" || reduced.matches) return;
    aimX = event.clientX;
    aimY = event.clientY;
    if (strength < .01) { x = aimX; y = aimY; }
    target = 1;
    schedule();
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", release);
  window.addEventListener("blur", release);
  reduced.addEventListener("change", () => { strength = 0; release(); });
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resize(); });
  resize();
}
mountMesh(byId("mesh"));
