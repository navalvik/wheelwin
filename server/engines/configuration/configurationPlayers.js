export function createConfigurationPlayer({
    playerId,
    sectorCount = 2,
    sectorArrangement = "together",
    colors = null,
    nickname = null,
    icon = null
}) {

    const palette = [
        ["Red"],
        ["Green", "Blue"],
        ["Yellow", "Orange"]
    ];

    const resolvedColors = colors
        ?? (sectorCount === 1
            ? palette[0]
            : palette[1]);

    return {
        playerId,
        nickname: nickname ?? playerId,
        sectorCount,
        sectorArrangement: sectorCount === 2 ? sectorArrangement : undefined,
        colors: resolvedColors,
        // R5.17 — authoritative icon required by ConfigurationEngine.
        icon: icon ?? "dice"
    };

}

export function createStandardConfigurationPlayers(playerIds) {

    const twoSectorColors = [
        ["Red", "Blue"],
        ["Green", "Yellow"],
        ["Orange", "Violet"]
    ];

    const icons = ["dice", "spade", "queen", "ladybug", "heart", "anchor"];

    return playerIds.map((playerId, index) => createConfigurationPlayer({
        playerId,
        sectorCount: 2,
        colors: twoSectorColors[index] ?? ["Red", "Blue"],
        icon: icons[index % icons.length]
    }));

}
