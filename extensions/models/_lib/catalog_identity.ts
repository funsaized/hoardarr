import { z } from "npm:zod@4.5.1";
const positiveId = z.number().int().positive();
const Kind = z.enum(["movie", "series", "episode"]);
const Alias = z.object({
  provider: z.enum(["tmdb", "tvmaze", "imdb", "tvdb"]),
  value: z.string().min(1).max(100),
});
export const CatalogIdentity = z.object({
  id: z.uuid(),
  kind: Kind,
  aliases: z.array(Alias),
  catalogKey: z.string().min(1),
});
type Identity = z.infer<typeof CatalogIdentity>;
type Kind = Identity["kind"];
type Alias = Identity["aliases"][number];

/** Validate the entire index before assigning new IDs under the installation lease. */
export function identityIndex(saved: Identity[]) {
  const byKey = new Map<string, Identity>(), byAlias = new Map<string, Identity>();
  const byId = new Set<string>();
  const aliasKey = (kind: Kind, alias: Alias) =>
    JSON.stringify([kind, alias.provider, alias.value]);
  for (const entity of saved) {
    if (byKey.has(entity.catalogKey) || byId.has(entity.id)) {
      throw new Error("Duplicate local identity");
    }
    byKey.set(entity.catalogKey, entity);
    byId.add(entity.id);
    for (const alias of entity.aliases) {
      const key = aliasKey(entity.kind, alias);
      if (byAlias.has(key)) throw new Error("Conflicting provider alias");
      byAlias.set(key, entity);
    }
  }
  const changed = new Map<string, Identity>();
  function reserve(kind: Kind, catalogKey: string, id: string) {
    const known = byKey.get(catalogKey);
    if (known) {
      if (known.kind !== kind || known.id !== id) {
        throw new Error("Conflicting local catalog identity");
      }
      return known;
    }
    if (byId.has(id)) throw new Error("Local catalog identity already in use");
    const entity = CatalogIdentity.parse({ id, kind, catalogKey, aliases: [] });
    byId.add(id);
    byKey.set(catalogKey, entity);
    changed.set(catalogKey, entity);
    return entity;
  }
  function confirm(kind: Kind, catalogKey: string, alias: Alias) {
    const known = byKey.get(catalogKey), owner = byAlias.get(aliasKey(kind, alias));
    if (owner && owner.catalogKey !== catalogKey || known && known.kind !== kind) {
      throw new Error("Provider alias requires identity review");
    }
    if (owner) return owner;
    const entity = {
      id: known?.id ?? crypto.randomUUID(),
      kind,
      catalogKey,
      aliases: [...(known?.aliases ?? []), alias],
    };
    byId.add(entity.id);
    byKey.set(catalogKey, entity);
    for (const id of entity.aliases) byAlias.set(aliasKey(kind, id), entity);
    changed.set(catalogKey, entity);
    return entity;
  }
  return { confirm, reserve, changed, byKey };
}

/** Existing numeric keys remain the ownership keys for staging and delivery receipts. */
export function movieCatalogId(movie: { catalogId?: unknown; tmdbId?: unknown }) {
  return positiveId.parse(movie.catalogId ?? movie.tmdbId);
}

export const MovieIdentityFields = {
  imdbId: z.string().regex(/^tt[0-9]{7,12}$/).optional(),
  tmdbId: z.number().int().positive().optional(),
  catalogId: z.number().int().positive().optional(),
  localId: z.uuid().optional(),
};
export function hasMovieIdentity(value: { tmdbId?: number; catalogId?: number; localId?: string }) {
  return value.tmdbId !== undefined ||
    (value.catalogId !== undefined && value.localId !== undefined);
}

export function episodeCatalogId(row: { catalogId?: unknown; tmdbEpisodeId?: unknown }) {
  return positiveId.parse(row.catalogId ?? row.tmdbEpisodeId);
}
export function seriesCatalogId(row: { seriesCatalogId?: unknown; showTmdbId?: unknown }) {
  return positiveId.parse(row.seriesCatalogId ?? row.showTmdbId);
}
export const EpisodeIdentityFields = {
  tmdbEpisodeId: z.number().int().positive().optional(),
  showTmdbId: z.number().int().positive().optional(),
  localId: z.uuid().optional(),
  catalogId: z.number().int().positive().optional(),
  seriesLocalId: z.uuid().optional(),
  seriesCatalogId: z.number().int().positive().optional(),
  tvmazeEpisodeId: z.number().int().positive().optional(),
  tvmazeSeriesId: z.number().int().positive().optional(),
  numbering: z.literal("tvmaze-aired").optional(),
};
export function hasEpisodeIdentity(
  row: Partial<Record<keyof typeof EpisodeIdentityFields, unknown>>,
) {
  return Boolean(
    row.tmdbEpisodeId && row.showTmdbId || row.localId && row.seriesLocalId &&
        row.catalogId && row.seriesCatalogId && row.tvmazeEpisodeId && row.tvmazeSeriesId &&
        row.numbering,
  );
}
