export const MIN_SECTOR_COUNT = 3;

export const MAX_SECTOR_COUNT = 6;

export const WHEEL_DIAMETER_SCALE = 0.92;

export const WHEEL_ANGLE = 0;

export const WHEEL_ICON_GLYPHS = Object.freeze({
    dice: "🎲",
    spade: "♠",
    queen: "♕",
    ladybug: "🐞",
    heart: "♥",
    anchor: "⚓",
    star: "★",
    diamond: "◆",
    turtle: "🐢",
    shark: "🦈",
    fox: "🦊",
    owl: "🦉",
    dolphin: "🐬",
    butterfly: "🦋",
    elephant: "🐘",
    lion: "🦁",
    panda: "🐼",
    rabbit: "🐰",
    cat: "🐱",
    dog: "🐶",
    bear: "🐻",
    frog: "🐸",
    snake: "🐍",
    eagle: "🦅"
});

export function resolveWheelIcon(iconKey) {

    if (!iconKey) {

        return "?";

    }

    const normalized = String(iconKey).trim().toLowerCase();

    if (WHEEL_ICON_GLYPHS[normalized]) {

        return WHEEL_ICON_GLYPHS[normalized];

    }

    return iconKey;

}

/**
 * R5.13B — Resolve a player's display icon from authoritative wheel sectors.
 * Uses the first sector owned by playerId; never reads roster / PlayerUI data.
 */
export function resolvePlayerIconFromWheel(sectors, playerId) {

    if (!Array.isArray(sectors) || !playerId) {

        return null;

    }

    const sector = sectors.find(
        (entry) => entry?.ownerId === playerId
    );

    if (!sector?.icon) {

        return null;

    }

    return resolveWheelIcon(sector.icon);

}

export function validateWheelConfiguration(config) {

    if (!config || !Array.isArray(config.sectors)) {

        throw new Error("Wheel configuration must include a sectors array");

    }

    const { sectors } = config;

    if (sectors.length < MIN_SECTOR_COUNT
        || sectors.length > MAX_SECTOR_COUNT) {

        throw new Error(
            `Wheel must have between ${MIN_SECTOR_COUNT} and `
            + `${MAX_SECTOR_COUNT} sectors`
        );

    }

    sectors.forEach((sector, index) => {

        if (!sector || typeof sector.color !== "string") {

            throw new Error(
                `Sector ${index} must include a color string`
            );

        }

        if (typeof sector.icon !== "string") {

            throw new Error(
                `Sector ${index} must include an icon string`
            );

        }

    });

    return {
        sectors: sectors.map((sector) => ({
            color: sector.color,
            icon: sector.icon
        }))
    };

}

export function getSectorAngleRadians(sectorCount) {

    return (Math.PI * 2) / sectorCount;

}

export function getSectorMidAngleRadians(
    sectorIndex,
    sectorCount,
    wheelAngleRadians = 0
) {

    const sectorAngle = getSectorAngleRadians(sectorCount);

    return (-Math.PI / 2) + wheelAngleRadians
        + (sectorIndex * sectorAngle)
        + (sectorAngle / 2);

}

export function calculateWheelDiameter(containerWidth, containerHeight) {

    return Math.min(containerWidth, containerHeight) * WHEEL_DIAMETER_SCALE;

}
