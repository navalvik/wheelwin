/**
 * R16.2C — Client mirror of server/console/auth/developerRoles.js
 */

export const DEVELOPER_ROLES = Object.freeze({
    VIEWER: "Viewer",
    ADMINISTRATOR: "Administrator",
    DEVELOPER: "Developer",
    OPERATOR: "Operator"
});

export function canPerformAdministratorActions(role) {

    return role === DEVELOPER_ROLES.ADMINISTRATOR
        || role === DEVELOPER_ROLES.OPERATOR;

}

/**
 * Whether Developer Console panels may expose mutation controls.
 */
export function canManageConsole({ authEnabled, status, session }) {

    if (!authEnabled || status === "open") {

        return true;

    }

    if (canPerformAdministratorActions(session?.role)) {

        return true;

    }

    // Align with server JWT: readOnly is true only for Viewer / legacy Developer.
    return session?.readOnly === false;

}
