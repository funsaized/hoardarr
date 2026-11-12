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

Deno.test("ambiguous main videos require an explicit resolution", async () => {
  await rejects(() => fileNames(["Part1.mkv", "Part2.mkv"], "Movie"));
  deepStrictEqual(fileNames(["Release.mkv", "Sample/sample.mkv"], "Movie"), [
    { from: "Release.mkv", to: "Movie.mkv" },
    { from: "Sample/sample.mkv", to: "Movie - sample-1.mkv" },
  ]);
});

Deno.test("duplicate subtitle languages retain every track with stable available suffixes", () => {
  const paths = [
    "Release.mkv",
    "Subs/B/English.srt",
    "Subs/A/English.srt",
    "Release.english.2.srt",
    "Subs/C/english.srt",
  ];
  const expected = [
    { from: "Release.english.2.srt", to: "Movie.english.2.srt" },
    { from: "Release.mkv", to: "Movie.mkv" },
    { from: "Subs/A/English.srt", to: "Movie.english.srt" },
    { from: "Subs/B/English.srt", to: "Movie.english.3.srt" },
    { from: "Subs/C/english.srt", to: "Movie.english.4.srt" },
  ];
  deepStrictEqual(fileNames(paths, "Movie"), expected);
  deepStrictEqual(fileNames(paths.toReversed(), "Movie"), expected);
});

Deno.test("subtitle labels retain regional variants and accessibility flags", () => {
  deepStrictEqual(
    fileNames([
      "Release.mp4",
      "Subs/Brazilian.por.srt",
      "Subs/European.por.srt",
      "Subs/SDH.eng.HI.srt",
    ], "Movie"),
    [
      { from: "Release.mp4", to: "Movie.mp4" },
      { from: "Subs/Brazilian.por.srt", to: "Movie.brazilian.por.srt" },
      { from: "Subs/European.por.srt", to: "Movie.european.por.srt" },
      { from: "Subs/SDH.eng.HI.srt", to: "Movie.sdh.eng.hi.srt" },
    ],
  );
});
