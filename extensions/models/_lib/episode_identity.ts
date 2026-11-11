/** Match the series prefix, never an episode title or a substring of another series. */
export function episodeIdentityMatches(
  episode: { showName: string; seasonNumber: number; episodeNumber: number; category: string },
  name: string,
): boolean {
  const token = episode.category === "anime"
    ? /\b(\d{1,2})x(\d{2,3})\b/i
    : /\bS(\d{1,2})E(\d{2,3})\b/i;
  const match = token.exec(name);
  if (
    !match || Number(match[1]) !== episode.seasonNumber ||
    Number(match[2]) !== episode.episodeNumber
  ) return false;
  // Reject multi-episode coverage until the catalog can represent it.
  if (
    /^(?:[ ._-]*E\d|[ ._-]*S\d|[ ._-]*\d{1,2}x\d)/i.test(name.slice(match.index + match[0].length))
  ) {
    return false;
  }
  const normalize = (s: string) =>
    s.normalize("NFKD").replace(/\p{M}/gu, "")
      .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const prefix = name.slice(0, match.index).trim()
    .replace(/^(?:\[[^\]]+\][ ._-]*)+/, "")
    .replace(/(?:[ ._-]+|\s*\()(?:19|20)\d{2}\)?[ ._-]*$/, "");
  const expected = normalize(episode.showName);
  return expected.length > 0 && normalize(prefix) === expected;
}
