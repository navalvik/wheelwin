/**
 * R6.1 — Developer Console roles (independent of gameplay).
 */

export const DEVELOPER_ROLES = Object.freeze({
    DEVELOPER: "Developer",
    // Reserved for later stages — not granted by default login.
    OPERATOR: "Operator",
    ADMINISTRATOR: "Administrator"
});

export const CONSOLE_READ_ROLES = Object.freeze([
    DEVELOPER_ROLES.DEVELOPER,
    DEVELOPER_ROLES.OPERATOR,
    DEVELOPER_ROLES.ADMINISTRATOR
]);

export function canAccessDeveloperConsole(role) {

    return CONSOLE_READ_ROLES.includes(role);

}

/**
 * Developer role is read-only console access.
 * No gameplay mutations, admin actions, room deletion,
 * settlement controls, or player management.
 */
export function isReadOnlyConsoleRole(role) {

    return role === DEVELOPER_ROLES.DEVELOPER;

}
