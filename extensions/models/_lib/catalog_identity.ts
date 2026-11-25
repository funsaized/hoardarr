import { z } from "npm:zod@4.5.1";
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
    byKey.set(catalogKey, entity);
    for (const id of entity.aliases) byAlias.set(aliasKey(kind, id), entity);
    changed.set(catalogKey, entity);
    return entity;
  }
  return { confirm, changed, byKey };
}
