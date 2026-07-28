/**
 * R6.2 — Administrator role enforcement tests.
 */
import assert from "node:assert/strict";

import {
    canPerformAdministratorActions,
    DEVELOPER_ROLES,
    isReadOnlyConsoleRole
} from "../console/auth/developerRoles.js";

assert.equal(isReadOnlyConsoleRole(DEVELOPER_ROLES.VIEWER), true);

assert.equal(isReadOnlyConsoleRole(DEVELOPER_ROLES.ADMINISTRATOR), false);

assert.equal(canPerformAdministratorActions(DEVELOPER_ROLES.ADMINISTRATOR), true);

assert.equal(canPerformAdministratorActions(DEVELOPER_ROLES.VIEWER), false);

console.log("developerRoles.test.js: all assertions passed");
