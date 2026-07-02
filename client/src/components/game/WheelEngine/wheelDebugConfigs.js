export const WHEEL_DEBUG_CONFIGS = Object.freeze({
    3: {
        sectors: [
            { color: "#1c73d0", icon: "dice" },
            { color: "#00aa44", icon: "spade" },
            { color: "#e67e00", icon: "queen" }
        ]
    },
    4: {
        sectors: [
            { color: "#1c73d0", icon: "dice" },
            { color: "#4f8dd8", icon: "dice" },
            { color: "#00aa44", icon: "spade" },
            { color: "#e67e00", icon: "queen" }
        ]
    },
    5: {
        sectors: [
            { color: "#2F74C8", icon: "dice" },
            { color: "#5B8FD5", icon: "dice" },
            { color: "#11B03E", icon: "spade" },
            { color: "#F08A00", icon: "ladybug" },
            { color: "#C7E4F7", icon: "heart" }
        ]
    },
    6: {
        sectors: [
            { color: "#1c73d0", icon: "dice" },
            { color: "#4f8dd8", icon: "dice" },
            { color: "#00aa44", icon: "spade" },
            { color: "#e67e00", icon: "queen" },
            { color: "#cfeaf4", icon: "heart" },
            { color: "#dff5ff", icon: "ladybug" }
        ]
    }
});

export const DEFAULT_WHEEL_SECTOR_COUNT = 6;

export function getWheelDebugConfig(sectorCount) {

    return WHEEL_DEBUG_CONFIGS[sectorCount]
        || WHEEL_DEBUG_CONFIGS[DEFAULT_WHEEL_SECTOR_COUNT];

}
