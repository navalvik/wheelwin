#!/usr/bin/env node
/**
 * R6.1 — Generate ADMIN_PASSWORD_HASH for Developer Dashboard authentication.
 *
 * Usage:
 *   node server/scripts/hash-admin-password.js "your-strong-password"
 */

import { hashAdminPassword } from "../console/auth/adminPasswordHash.js";

const password = process.argv[2];

if (!password) {

    console.error("Usage: node server/scripts/hash-admin-password.js <password>");

    process.exit(1);

}

console.log(hashAdminPassword(password));
