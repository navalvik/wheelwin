/**
 * R6.0B / R6.0E — Developer Console navigation sections.
 */
export const CONSOLE_SECTIONS = Object.freeze([
    Object.freeze({ id: "server-health", label: "Server Health" }),
    Object.freeze({ id: "system-info", label: "System Information" }),
    Object.freeze({ id: "blockchain-status", label: "Blockchain Status" }),
    Object.freeze({ id: "closed-beta", label: "Closed Beta" }),
    Object.freeze({ id: "launch-readiness", label: "Launch Readiness" }),
    Object.freeze({ id: "general-availability", label: "General Availability" }),
    Object.freeze({ id: "post-launch-operations", label: "Post-Launch Ops" }),
    Object.freeze({ id: "platform-governance", label: "Platform Governance" }),
    Object.freeze({ id: "rooms", label: "Rooms" }),
    Object.freeze({ id: "games", label: "Games" }),
    Object.freeze({ id: "players", label: "Players" }),
    Object.freeze({ id: "payments", label: "Payments" }),
    Object.freeze({ id: "advertising", label: "Advertising" }),
    Object.freeze({ id: "tonconnect", label: "TonConnect Diagnostics" }),
    Object.freeze({ id: "history", label: "History" }),
    Object.freeze({ id: "recovery", label: "Recovery" }),
    Object.freeze({ id: "simulation", label: "Simulation" }),
    Object.freeze({ id: "event-bus", label: "Event Bus" }),
    Object.freeze({ id: "metrics", label: "Metrics" }),
    Object.freeze({ id: "timeline", label: "Timeline" }),
    Object.freeze({ id: "logs", label: "Developer Log" }),
    Object.freeze({ id: "settings", label: "Settings" }),
    Object.freeze({ id: "maintenance", label: "Maintenance", reserved: true })
]);

export const DEFAULT_CONSOLE_SECTION_ID = CONSOLE_SECTIONS[0].id;

export function getConsoleSection(sectionId) {

    return CONSOLE_SECTIONS.find((section) => section.id === sectionId)
        ?? CONSOLE_SECTIONS[0];

}
