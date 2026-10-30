export function resolveOpenPage5GameKey(payload, identity) {
    return payload?.gameId
        ?? identity?.gameId
        ?? identity?.roomId
        ?? null;
}

export function isDuplicateOpenPage5(lastOpenedGameKey, payload, identity) {
    const gameKey = resolveOpenPage5GameKey(payload, identity);
    return Boolean(gameKey && lastOpenedGameKey === gameKey);
}
