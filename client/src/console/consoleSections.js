/**
 * R6.0B / R6.0E / R17.9F.2 — Developer Console navigation sections.
 *
 * Single registry for sidebar labels, grouping, and reserved placeholders.
 * Panel components remain wired in DeveloperConsole.jsx (safe incremental step).
 */

export const CONSOLE_GROUP_IDS = Object.freeze({
    SYSTEM: "SYSTEM",
    GAME_OPERATIONS: "GAME_OPERATIONS",
    FINANCIAL: "FINANCIAL",
    BLOCKCHAIN: "BLOCKCHAIN",
    DEPLOYMENT: "DEPLOYMENT",
    PLATFORM: "PLATFORM",
    CONFIGURATION: "CONFIGURATION"
});

/** Display order and labels for sidebar groups. */
export const CONSOLE_GROUPS = Object.freeze([
    Object.freeze({
        id: CONSOLE_GROUP_IDS.SYSTEM,
        label: "SYSTEM",
        defaultExpanded: true
    }),
    Object.freeze({
        id: CONSOLE_GROUP_IDS.GAME_OPERATIONS,
        label: "GAME OPERATIONS",
        defaultExpanded: true
    }),
    Object.freeze({
        id: CONSOLE_GROUP_IDS.FINANCIAL,
        label: "FINANCIAL",
        defaultExpanded: true
    }),
    Object.freeze({
        id: CONSOLE_GROUP_IDS.BLOCKCHAIN,
        label: "BLOCKCHAIN",
        defaultExpanded: false
    }),
    Object.freeze({
        id: CONSOLE_GROUP_IDS.DEPLOYMENT,
        label: "DEPLOYMENT",
        defaultExpanded: false
    }),
    Object.freeze({
        id: CONSOLE_GROUP_IDS.PLATFORM,
        label: "PLATFORM",
        defaultExpanded: false
    }),
    Object.freeze({
        id: CONSOLE_GROUP_IDS.CONFIGURATION,
        label: "CONFIGURATION",
        defaultExpanded: false
    })
]);

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   group: string,
 *   reserved?: boolean
 * }} ConsoleSectionDef
 */

/** @type {ReadonlyArray<Readonly<ConsoleSectionDef>>} */
export const CONSOLE_SECTIONS = Object.freeze([
    // SYSTEM
    Object.freeze({
        id: "server-health",
        label: "Server Health",
        group: CONSOLE_GROUP_IDS.SYSTEM
    }),
    Object.freeze({
        id: "system-info",
        label: "System Information",
        group: CONSOLE_GROUP_IDS.SYSTEM
    }),
    Object.freeze({
        id: "metrics",
        label: "Metrics",
        group: CONSOLE_GROUP_IDS.SYSTEM
    }),
    Object.freeze({
        id: "event-bus",
        label: "Event Bus",
        group: CONSOLE_GROUP_IDS.SYSTEM
    }),
    Object.freeze({
        id: "timeline",
        label: "Timeline",
        group: CONSOLE_GROUP_IDS.SYSTEM
    }),
    Object.freeze({
        id: "logs",
        label: "Developer Log",
        group: CONSOLE_GROUP_IDS.SYSTEM
    }),

    // GAME OPERATIONS
    Object.freeze({
        id: "rooms",
        label: "Rooms",
        group: CONSOLE_GROUP_IDS.GAME_OPERATIONS
    }),
    Object.freeze({
        id: "games",
        label: "Games",
        group: CONSOLE_GROUP_IDS.GAME_OPERATIONS
    }),
    Object.freeze({
        id: "players",
        label: "Players",
        group: CONSOLE_GROUP_IDS.GAME_OPERATIONS
    }),
    Object.freeze({
        id: "simulation",
        label: "Simulation",
        group: CONSOLE_GROUP_IDS.GAME_OPERATIONS
    }),
    Object.freeze({
        id: "recovery",
        label: "Recovery",
        group: CONSOLE_GROUP_IDS.GAME_OPERATIONS
    }),
    Object.freeze({
        id: "history",
        label: "History",
        group: CONSOLE_GROUP_IDS.GAME_OPERATIONS
    }),

    // FINANCIAL
    Object.freeze({
        id: "payments",
        label: "Payments",
        group: CONSOLE_GROUP_IDS.FINANCIAL
    }),

    // BLOCKCHAIN
    Object.freeze({
        id: "blockchain-status",
        label: "Blockchain Status",
        group: CONSOLE_GROUP_IDS.BLOCKCHAIN
    }),
    Object.freeze({
        id: "ton-deployer-wallet",
        label: "TON Deployer Wallet",
        group: CONSOLE_GROUP_IDS.BLOCKCHAIN
    }),
    Object.freeze({
        id: "tonconnect",
        label: "TonConnect Diagnostics",
        group: CONSOLE_GROUP_IDS.BLOCKCHAIN
    }),

    // DEPLOYMENT
    Object.freeze({
        id: "closed-beta",
        label: "Closed Beta",
        group: CONSOLE_GROUP_IDS.DEPLOYMENT
    }),
    Object.freeze({
        id: "launch-readiness",
        label: "Launch Readiness",
        group: CONSOLE_GROUP_IDS.DEPLOYMENT
    }),
    Object.freeze({
        id: "general-availability",
        label: "General Availability",
        group: CONSOLE_GROUP_IDS.DEPLOYMENT
    }),
    Object.freeze({
        id: "post-launch-operations",
        label: "Post-Launch Ops",
        group: CONSOLE_GROUP_IDS.DEPLOYMENT
    }),

    // PLATFORM
    Object.freeze({
        id: "advertising",
        label: "Advertising",
        group: CONSOLE_GROUP_IDS.PLATFORM
    }),
    Object.freeze({
        id: "platform-governance",
        label: "Platform Governance",
        group: CONSOLE_GROUP_IDS.PLATFORM
    }),
    Object.freeze({
        id: "settings",
        label: "Settings",
        group: CONSOLE_GROUP_IDS.PLATFORM
    }),
    Object.freeze({
        id: "maintenance",
        label: "Maintenance",
        group: CONSOLE_GROUP_IDS.PLATFORM,
        reserved: true
    }),

    // CONFIGURATION (placeholders for later stages)
    Object.freeze({
        id: "runtime-configuration",
        label: "Runtime Configuration",
        group: CONSOLE_GROUP_IDS.CONFIGURATION,
        reserved: true
    }),
    Object.freeze({
        id: "audio-registry",
        label: "Audio Registry",
        group: CONSOLE_GROUP_IDS.CONFIGURATION,
        reserved: true
    })
]);

export const DEFAULT_CONSOLE_SECTION_ID = CONSOLE_SECTIONS[0].id;

export function getConsoleSection(sectionId) {

    return CONSOLE_SECTIONS.find((section) => section.id === sectionId)
        ?? CONSOLE_SECTIONS[0];

}

/**
 * @param {string} groupId
 * @returns {ReadonlyArray<Readonly<ConsoleSectionDef>>}
 */
export function getConsoleSectionsInGroup(groupId) {

    return CONSOLE_SECTIONS.filter((section) => section.group === groupId);

}

/**
 * @returns {ReadonlyArray<{
 *   group: Readonly<{ id: string, label: string, defaultExpanded: boolean }>,
 *   sections: ReadonlyArray<Readonly<ConsoleSectionDef>>
 * }>}
 */
export function getConsoleNavTree() {

    return CONSOLE_GROUPS.map((group) => Object.freeze({
        group,
        sections: getConsoleSectionsInGroup(group.id)
    }));

}
