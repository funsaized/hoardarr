import { deepStrictEqual } from "node:assert";
import { fileNames, libraryNames, namePart } from "./_lib/library_naming.ts";
import { assert, rejects } from "../../tests/helpers.ts";

Deno.test("canonical names retain title, year, season and subtitle language", () => {
  const names = libraryNames({
    mediaKind: "episode",
    id: 12,
    title: "A: Show?",
    year: 2022,
    seasonNumber: 1,
    episodeNumber: 2,
    episodeTitle: "A / Beginning",
  });
  deepStrictEqual(names, {
    directory: "TV/A Show (2022)/Season 01",
    stem: "A Show - S01E02 - A Beginning",
  });
  deepStrictEqual(fileNames(["Release.mkv", "Release.en.forced.srt", "Subs/es.srt"], names.stem), [
    { from: "Release.en.forced.srt", to: `${names.stem}.en.forced.srt` },
    { from: "Release.mkv", to: `${names.stem}.mkv` },
    { from: "Subs/es.srt", to: `${names.stem}.es.srt` },
  ]);
  assert(namePart("CON") === "_CON");
  assert(new TextEncoder().encode(namePart("界".repeat(200))).length <= 180);
});

Deno.test("ambiguous main videos and subtitle name collisions require an explicit resolution", async () => {
  await rejects(() => fileNames(["Part1.mkv", "Part2.mkv"], "Movie"));
  await rejects(() => fileNames(["Release.mkv", "Subs/en.srt", "Other/en.srt"], "Movie"));
  deepStrictEqual(fileNames(["Release.mkv", "Sample/sample.mkv"], "Movie"), [
    { from: "Release.mkv", to: "Movie.mkv" },
    { from: "Sample/sample.mkv", to: "Movie - sample-1.mkv" },
  ]);
});
