/**
 * R6.0B — Console store foundation (mirror only; no live stream yet).
 * Reserved for ConsoleStreamProvider / DeveloperConsoleGateway (later stages).
 */
export const CONSOLE_STORE_INITIAL_STATE = Object.freeze({
    activeSectionId: null,
    connected: false,
    // R6.1 — Developer Login session (not implemented).
    developerSession: null
});
