/** Deterministic library names; metadata identity remains in the catalog. */
import { basename } from "node:path";
import { extensionOf } from "./media_paths.ts";
import { LibraryItemError } from "../local_destination.ts";

export const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "webm",
  "ts",
  "m2ts",
  "mpg",
  "mpeg",
]);

/** Portable, bounded filename component, retaining Unicode titles. */
export function namePart(value: string, fallback = "Untitled", maxBytes = 180): string {
  let name = value.normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (!name || name === "." || name === "..") name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
  const encoder = new TextEncoder();
  while (encoder.encode(name).length > maxBytes) name = [...name].slice(0, -1).join("");
  return name.replace(/[. ]+$/, "");
}

export type MediaNames = {
  mediaKind: "movie" | "episode";
  id: number;
  title: string;
  year?: number | null;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string | null;
};

export function libraryNames(
  media: MediaNames,
  folder?: string,
): { directory: string; stem: string } {
  const title = namePart(media.title, `Untitled ${media.id}`, 100);
  const dated = namePart(`${title}${media.year ? ` (${media.year})` : ""}`);
  if (media.mediaKind === "movie") return { directory: folder ?? `Movies/${dated}`, stem: dated };
  if (!Number.isInteger(media.seasonNumber) || !Number.isInteger(media.episodeNumber)) {
    throw new LibraryItemError(
      "missing-episode-metadata",
      "Season and episode numbers are required",
    );
  }
  const season = String(media.seasonNumber).padStart(2, "0");
  const episode = String(media.episodeNumber).padStart(2, "0");
  return {
    directory: `${folder ?? `TV/${dated}`}/Season ${season}`,
    stem: namePart(
      `${title} - S${season}E${episode}${media.episodeTitle ? ` - ${media.episodeTitle}` : ""}`,
    ),
  };
}

/** Map one main video, its subtitles, and explicit sample clips without guessing coverage. */
export function fileNames(paths: string[], stem: string): { from: string; to: string }[] {
  const ordered = [...paths].sort();
  const videos = ordered.filter((p) => VIDEO_EXTENSIONS.has(extensionOf(p) ?? ""));
  const sample = (p: string) => /(?:^|[\/ ._-])sample(?:[\/ ._-]|$)/i.test(p);
  const main = videos.filter((p) => !sample(p));
  if (main.length !== 1) {
    throw new LibraryItemError("ambiguous-video", `Expected one main video; found ${main.length}`);
  }
  const mainBase = basename(main[0]);
  const mainStem = mainBase.slice(0, mainBase.lastIndexOf("."));
  let sampleIndex = 0, subtitleIndex = 0;
  const mappings = ordered.map((from) => {
    const ext = extensionOf(from)!;
    if (from === main[0]) return { from, to: `${stem}.${ext}` };
    if (VIDEO_EXTENSIONS.has(ext)) {
      return { from, to: `${stem} - sample-${++sampleIndex}.${ext}` };
    }
    const base = basename(from), oldStem = base.slice(0, base.lastIndexOf("."));
    let suffix = oldStem.startsWith(mainStem) ? oldStem.slice(mainStem.length) : "";
    if (!suffix && oldStem !== mainStem) suffix = oldStem;
    suffix = suffix.replace(/^[ ._-]+/, "").replace(/[ _]+/g, ".").toLowerCase();
    if (!suffix && ++subtitleIndex > 1) suffix = `subtitle-${subtitleIndex}`;
    return { from, to: `${stem}${suffix ? "." + namePart(suffix, "subtitles", 40) : ""}.${ext}` };
  });
  // Releases can contain several subtitle tracks with the same language label.
  // Keep every track, reserving explicit names before allocating stable suffixes.
  const reserved = new Set(mappings.map((m) => m.to.toLowerCase()));
  const used = new Set<string>();
  for (const mapping of mappings) {
    if (used.has(mapping.to.toLowerCase())) {
      const dot = mapping.to.lastIndexOf(".");
      const base = mapping.to.slice(0, dot), ext = mapping.to.slice(dot);
      let index = 2, candidate: string;
      do candidate = `${base}.${index++}${ext}`; while (reserved.has(candidate.toLowerCase()));
      mapping.to = candidate;
      reserved.add(candidate.toLowerCase());
    }
    used.add(mapping.to.toLowerCase());
  }
  return mappings;
}
