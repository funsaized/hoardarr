type Slot = { seasonNumber?: unknown; episodeNumber?: unknown };

/** Unlabelled payload names can inherit coverage from a verified single-episode release. */
export function episodeCoverage(name: string, slot: Slot) {
  const tokens = [
    ...name.matchAll(/(?<![a-z0-9])(?:S(\d{1,2})E(\d{2,3})|(\d{1,2})x(\d{2,3}))(?!\d)/gi),
  ];
  const first = tokens[0];
  if (!first) return { kind: "unlabelled" } as const;
  const suffix = name.slice(first.index + first[0].length);
  if (
    tokens.length > 1 ||
    /^(?:[ ._+-]*(?:E\d|S\d|\d{1,2}x\d)|\s*[-+–—]\s*\d{1,3}(?![a-z0-9]))/i.test(suffix)
  ) {
    return { kind: "multiple" } as const;
  }
  if (
    /^[a-z0-9]/i.test(suffix) || Number(first[1] ?? first[3]) !== slot.seasonNumber ||
    Number(first[2] ?? first[4]) !== slot.episodeNumber
  ) return { kind: "different" } as const;
  return { kind: "exact", index: first.index, category: first[1] ? "tv" : "anime" } as const;
}

/** Match the series prefix, never an episode title or a substring of another series. */
export function episodeIdentityMatches(
  episode: {
    showName: string;
    showYear?: number;
    seasonNumber: number;
    episodeNumber: number;
    category: string;
  },
  name: string,
): boolean {
  const coverage = episodeCoverage(name, episode);
  if (coverage.kind !== "exact" || coverage.category !== episode.category) return false;
  const normalize = (s: string) =>
    s.normalize("NFKD").replace(/\p{M}/gu, "")
      .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  let prefix = name.slice(0, coverage.index).trim()
    .replace(/^(?:\[[^\]]+\][ ._-]*)+/, "");
  const expected = normalize(episode.showName);
  if (expected.length > 0 && normalize(prefix) === expected) return true;
  const year = /(?:[ ._-]+|\s*[\[(])((?:19|20)\d{2})[\])]?([ ._-]*)$/.exec(prefix);
  if (year) {
    if (episode.showYear !== undefined && Number(year[1]) !== episode.showYear) return false;
    prefix = prefix.slice(0, year.index);
  }
  return expected.length > 0 && normalize(prefix) === expected;
}
