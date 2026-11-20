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
function describe(r) {
  return [
    r.rank && "#" + r.rank,
    r.state,
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
  const byHash = new Map(catalog.rows.filter((r) => r.hash).map((r) => [r.hash.toLowerCase(), r]));
  const joined = new Set();
  const rows = live.rows.map((t) => {
    const c = byHash.get(t.id.toLowerCase());
    if (c) joined.add(c.id);
    return { ...t, id: c?.id ?? t.id, title: c?.title ?? t.title, release: t.title };
  });
  rows.push(
    ...catalog.rows.filter((c) => !joined.has(c.id)).map((c) => ({
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
  stages.forEach((s, i) => {
    const b = byId("stages").children[i];
    b.lastChild.textContent = unknown(s) ? "—" : groups.get(s).length;
    b.setAttribute("aria-pressed", s === current);
  });
  function list(node, items, empty) {
    const previous = document.activeElement?.dataset.id;
    node.replaceChildren();
    for (const r of items) {
      const b = element("button", "", "row");
      b.dataset.id = r.id;
      b.setAttribute("aria-pressed", r.id === selected);
      b.append(element("b", r.title), element("span", describe(r), "meta"));
      if (r.progress != null && r.state === "downloading") {
        const p = element("progress", "");
        p.value = r.progress;
        p.max = 100;
        p.setAttribute("aria-label", "Download progress");
        b.append(p);
      }
      b.onclick = () => {
        selected = r.id;
        render();
      };
      node.append(b);
      if (previous === r.id) b.focus({ preventScroll: true });
    }
    if (!items.length) node.append(element("p", empty, "empty"));
  }
  byId("group").textContent = current;
  list(
    byId("items"),
    groups.get(current),
    unknown(current) ? "Waiting for a reading." : "No items in this stage.",
  );
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
  freshness();
}
for (const stage of stages) {
  const b = element("button", "");
  b.append(element("small", stage), element("strong", "—"));
  b.onclick = () => {
    current = stage;
    render();
  };
  byId("stages").append(b);
}
async function update() {
  clearTimeout(timer);
  if (document.hidden || loading) return;
  loading = true;
  try {
    const r = await fetch("/api/board", { signal: AbortSignal.timeout(55000) });
    if (!r.ok) throw Error();
    snapshot = await r.json();
    offline = false;
    render();
  } catch {
    offline = true;
    if (snapshot) render();
    else byId("health").textContent = "Board unavailable · retrying";
  } finally {
    loading = false;
    const fast = offline || snapshot?.live.stale || snapshot?.catalog.stale ||
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
