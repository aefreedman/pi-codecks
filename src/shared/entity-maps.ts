import { getAccount, getRelation, normalizeCollection, unwrapData } from "./query";
import { type CodecksEntity } from "./types";

export const extractEntitiesFromPayload = (
    payload: unknown,
    relationName: string,
    mapName: string,
): CodecksEntity[] =>
{
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const entries = normalizeCollection(getRelation(account, relationName) as unknown[] | undefined);
    const map = getEntityMap(data, mapName);

    return entries
        .map((entry) =>
        {
            if (typeof entry === "object" && entry)
            {
                return entry as CodecksEntity;
            }

            const key = String(entry);
            const entity = map[key];
            if (entity && entity.id === undefined)
            {
                return { ...entity, id: key };
            }

            return entity;
        })
        .filter((entry): entry is CodecksEntity => Boolean(entry));
};

export const extractRelationEntities = (
    entity: CodecksEntity | undefined,
    relationName: string,
    map: Record<string, CodecksEntity>,
): CodecksEntity[] =>
{
    if (!entity)
    {
        return [];
    }

    const entries = normalizeCollection(getRelation(entity, relationName) as unknown[] | undefined);

    return entries
        .map((entry) =>
        {
            if (typeof entry === "object" && entry)
            {
                return entry as CodecksEntity;
            }

            const key = String(entry);
            const resolved = map[key];
            if (resolved && resolved.id === undefined)
            {
                return { ...resolved, id: key };
            }

            return resolved;
        })
        .filter((entry): entry is CodecksEntity => Boolean(entry));
};

export const getEntityMap = (data: Record<string, unknown> | undefined, key: string): Record<string, CodecksEntity> =>
{
    if (!data)
    {
        return {};
    }

    const map = data[key];
    if (!map || typeof map !== "object")
    {
        return {};
    }

    return map as Record<string, CodecksEntity>;
};

export const resolveFromMap = (value: unknown, map: Record<string, CodecksEntity>): CodecksEntity | undefined =>
{
    if (!value)
    {
        return undefined;
    }

    if (typeof value === "object")
    {
        return value as CodecksEntity;
    }

    const key = String(value);
    return map[key];
};
