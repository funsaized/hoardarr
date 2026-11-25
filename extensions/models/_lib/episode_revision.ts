import { createHash } from "node:crypto";
export function episodeRevision(
  series: number,
  e: {
    id: number;
    name?: string | null;
    season?: number | null;
    number?: number | null;
    type?: string;
    airdate?: string | null;
    airstamp?: string | null;
  },
) {
  return createHash("sha256").update(
    JSON.stringify([series, e.id, e.name, e.season, e.number, e.type, e.airdate, e.airstamp]),
  ).digest("hex");
}
