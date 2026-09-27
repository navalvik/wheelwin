/**
 * R17.9T.7 — Minimal recoveryCredential repair (client side).
 *
 * Verifies, for `client/src/context/RecoveryExperienceContext.jsx`:
 * 1. The SESSION_RECOVERY_REQUEST trace now reports
 *    `credentialPresent: Boolean(identity.recoveryCredential)` (additive
 *    diagnostic only).
 * 2. The `onSetupSessionSync` handler persists a server-issued
 *    `payload.recoveryCredential` through the EXISTING
 *    PlayerIdentityContext setter (`setIdentity`) — merge-only, so
 *    roomId / playerId / gameId are never replaced or cleared.
 * 3. No credential in the payload → no identity write at all.
 * 4. The recovery request protocol itself is unchanged
 *    (`recoveryCredential: identity.recoveryCredential ?? null`).
 * 5. No new storage mechanism (no localStorage) is introduced.
 *
 * The Node test harness has no JSX loader (client/scripts/loaderHooks.js only
 * appends `.js` for extensionless relative imports), so — following the
 * established `HeaderBar.mainnetHandoff.test.js` pattern — the handler block
 * is extracted VERBATIM from the context file between stable code markers and
 * executed with fakes. This runs the real production decision logic, not a
 * copy.
 */

import { readFileSync } from "node:fs";

import assert from "node:assert/strict";

import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

const contextSource = readFileSync(
    join(currentDir, "RecoveryExperienceContext.jsx"),
    "utf8"
);

/**
 * Extract a full function block verbatim by matching braces from the first
 * `{` after the signature. The handler block contains no brace characters
 * inside string literals, so naive counting is safe here.
 */
function extractFunction(source, signature) {

    const signatureIndex = source.indexOf(signature);

    assert.notEqual(
        signatureIndex,
        -1,
        `RecoveryExperienceContext.jsx must declare ${signature}`
    );

    const openBraceIndex = source.indexOf("{", signatureIndex);

    assert.notEqual(openBraceIndex, -1, "handler must open a block");

    let depth = 0;

    for (let index = openBraceIndex; index < source.length; index++) {

        if (source[index] === "{") {

            depth++;

        } else if (source[index] === "}") {

            depth--;

            if (depth === 0) {

                return source.slice(signatureIndex, index + 1);

            }

        }

    }

    assert.fail(`unbalanced braces after ${signature}`);

}

const HANDLER_SIGNATURE = "function onSetupSessionSync(payload) {";

const handlerSource = extractFunction(contextSource, HANDLER_SIGNATURE);

function evaluateHandler({
    isSetupRecoveryPageResult = false,
    identity = { roomId: "room-x", playerId: "player-x", gameId: null }
} = {}) {

    const calls = {
        trace: [],
        setIdentity: [],
        setupComplete: []
    };

    const onSetupSessionSync = new Function(
        "recoveryTrace",
        "setIdentity",
        "isSetupRecoveryPage",
        "handleSetupRecoveryComplete",
        "getIdentity",
        "currentPage",
        `${handlerSource}
return onSetupSessionSync;`
    )(
        (stage, details) => {

            calls.trace.push({ stage, details });

        },
        (partial) => {

            calls.setIdentity.push(partial);

        },
        () => isSetupRecoveryPageResult,
        () => {

            calls.setupComplete.push(true);

        },
        () => identity,
        "page-payment"
    );

    return { onSetupSessionSync, calls };

}

// ---------------------------------------------------------------------------
// 1. Credential present → merged through the existing PlayerIdentityContext
//    setter, touching ONLY recoveryCredential.
// ---------------------------------------------------------------------------

{

    const { onSetupSessionSync, calls } = evaluateHandler();

    onSetupSessionSync({
        roomId: "room-x",
        recoveryCredential: "fresh-credential-abc"
    });

    assert.equal(
        calls.setIdentity.length,
        1,
        "credential present → exactly one setIdentity call"
    );

    assert.deepEqual(
        calls.setIdentity[0],
        { recoveryCredential: "fresh-credential-abc" },
        "persistence must be merge-only: ONLY recoveryCredential is written"
    );

    assert.equal(
        "roomId" in calls.setIdentity[0]
            || "playerId" in calls.setIdentity[0]
            || "gameId" in calls.setIdentity[0],
        false,
        "roomId / playerId / gameId must never be replaced or cleared"
    );

    assert.equal(
        calls.setupComplete.length,
        0,
        "non-recovery page must not trigger setup completion"
    );

    console.log("  1. credential present → merge-only persistence via setIdentity");

}

// ---------------------------------------------------------------------------
// 2. No credential in payload → no identity write at all (existing behaviour).
// ---------------------------------------------------------------------------

{

    const { onSetupSessionSync, calls } = evaluateHandler();

    onSetupSessionSync({ roomId: "room-x" });

    onSetupSessionSync(null);

    onSetupSessionSync({ recoveryCredential: "" });

    assert.equal(
        calls.setIdentity.length,
        0,
        "absent / empty credential must not write identity"
    );

    console.log("  2. no credential → no identity write");

}

// ---------------------------------------------------------------------------
// 3. Existing setup-completion behaviour is preserved alongside the repair.
// ---------------------------------------------------------------------------

{

    const { onSetupSessionSync, calls } = evaluateHandler({
        isSetupRecoveryPageResult: true
    });

    onSetupSessionSync({ roomId: "room-x" });

    assert.equal(
        calls.setupComplete.length,
        1,
        "setup recovery page must still complete on SYNC"
    );

    console.log("  3. SETUP_SESSION_SYNC completion behaviour unchanged");

}

// ---------------------------------------------------------------------------
// 4. Structural wiring of the real context file.
// ---------------------------------------------------------------------------

{

    assert.match(
        contextSource,
        /credentialPresent:\s*Boolean\(identity\.recoveryCredential\)/,
        "request trace must report credentialPresent from the identity"
    );

    assert.match(
        contextSource,
        /recoveryCredential:\s*identity\.recoveryCredential \?\? null/,
        "SESSION_RECOVERY_REQUEST protocol must remain unchanged"
    );

    assert.match(
        contextSource,
        /const \{ getIdentity, clearIdentity, setIdentity \} = usePlayerIdentity\(\)/,
        "persistence must reuse the existing PlayerIdentityContext setter"
    );

    assert.equal(
        /localStorage/.test(contextSource),
        false,
        "no new storage mechanism may be introduced"
    );

    console.log("  4. trace + protocol + setter wiring verified");

}

process.stdout.write(
    "RecoveryExperienceContext.setupSyncCredentialRepair tests passed"
    + String.fromCharCode(10)
);

