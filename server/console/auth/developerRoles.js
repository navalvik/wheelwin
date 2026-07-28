/**
 * R6.1 / R6.2 — Developer Console roles (independent of gameplay).
 */

export const DEVELOPER_ROLES = Object.freeze({
    VIEWER: "Viewer",
    ADMINISTRATOR: "Administrator",
    // Legacy aliases retained for JWT compatibility.
    DEVELOPER: "Developer",
    OPERATOR: "Operator"
});

export const CONSOLE_READ_ROLES = Object.freeze([
    DEVELOPER_ROLES.VIEWER,
    DEVELOPER_ROLES.ADMINISTRATOR,
    DEVELOPER_ROLES.DEVELOPER,
    DEVELOPER_ROLES.OPERATOR
]);

export const ADMINISTRATOR_ROLES = Object.freeze([
    DEVELOPER_ROLES.ADMINISTRATOR,
    DEVELOPER_ROLES.OPERATOR
]);

export function canAccessDeveloperConsole(role) {

    return CONSOLE_READ_ROLES.includes(role);

}

export function isReadOnlyConsoleRole(role) {

    return role === DEVELOPER_ROLES.VIEWER
        || role === DEVELOPER_ROLES.DEVELOPER;

}

export function canPerformAdministratorActions(role) {

    return ADMINISTRATOR_ROLES.includes(role);

}
