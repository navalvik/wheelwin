/**
 * R24 — unit tests for the client-side room network handoff module
 * (`client/src/network/roomNetworkHandoff.js`).
 *
 * Covered invariants:
 * 1. Minimal payload validation (Owner-only R22 event): handoffId shape,
 *    targetNetwork mainnet, future expiresAt. No client-side ownership
 *    validation exists or is attempted.
 * 2. Expired handoffs are rejected locally and never stored/launched.
 * 3. Temporary persistence stores ONLY { handoffId, targetNetwork,
 *    expiresAt } — never Telegram identity, initData, wallet secrets,
 *    player credentials, socket ids or Testnet room state.
 * 4. The Mainnet deep link carries ONLY the opaque handoffId inside the
 *    startapp value (Telegram 64-char / A-Za-z0-9_- constraint) — no
 *    identity fields of any kind.
 * 5. start_param parsing is transport-only: plain "mainnet" and foreign or
 *    forged payloads yield null (normal direct-Mainnet session).
 * 6. The launcher reuses the established R18 mechanism: Telegram-native
 *    openTelegramLink first, plain-browser Mainnet URL fallback, and never
 *    navigates without a valid handoffId.
 */

import assert from "node:assert/strict";

import {
    buildMainnetDeepLink,
    clearHandoff,
    hasTelegramInitData,
    isHandoffExpired,
    isTestnetRuntime,
    launchMainnetMiniApp,
    readHandoff,
    readMainnetStartParam,
    readStartParamHandoff,
    storeHandoff,
    validateHandoffReadyPayload
} from "./roomNetworkHandoff.js";

const HANDOFF_ID = "Ab12Cd34Ef56Gh78Ij90Kl12";

function createFakeStorage(initial = {}) {

    const map = new Map(Object.entries(initial));

    return {
        getItem: (key) => map.has(key) ? map.get(key) : null,
        setItem: (key, value) => {
            map.set(key, String(value));
        },
        removeItem: (key) => {
            map.delete(key);
        },
        _map: map
    };

}

const NOW = 1_700_000_000_000;

const VALID_PAYLOAD = {
    roomId: "R24TEST",
    handoffId: HANDOFF_ID,
    targetNetwork: "mainnet",
    expiresAt: NOW + 120_000
};

// 1 — minimal payload validation.

{

    const handoff = validateHandoffReadyPayload(VALID_PAYLOAD, NOW);

    assert.ok(handoff, "a valid MAINNET payload must validate");
    assert.equal(handoff.handoffId, HANDOFF_ID);
    assert.equal(handoff.targetNetwork, "mainnet");
    assert.equal(handoff.expiresAt, NOW + 120_000);

    assert.equal(
        validateHandoffReadyPayload(null, NOW),
        null,
        "null payload must be rejected"
    );

    assert.equal(
        validateHandoffReadyPayload({ ...VALID_PAYLOAD, targetNetwork: "testnet" }, NOW),
        null,
        "non-mainnet target must be rejected"
    );

    assert.equal(
        validateHandoffReadyPayload({ ...VALID_PAYLOAD, handoffId: "short" }, NOW),
        null,
        "undersized handoffId must be rejected"
    );

    assert.equal(
        validateHandoffReadyPayload(
            { ...VALID_PAYLOAD, handoffId: "bad id with spaces and !!" },
            NOW
        ),
        null,
        "handoffId outside the base64url alphabet must be rejected"
    );

    assert.equal(
        validateHandoffReadyPayload({ ...VALID_PAYLOAD, expiresAt: NOW - 1 }, NOW),
        null,
        "already-expired handoff must be rejected locally"
    );

    assert.equal(
        validateHandoffReadyPayload({ ...VALID_PAYLOAD, expiresAt: null }, NOW),
        null,
        "expiry-less handoff must be rejected at receipt time"
    );

    // Identity fields are simply ignored — never validated, never stored.
    const withInjectedIdentity = {
        ...VALID_PAYLOAD,
        telegramUserId: "999",
        initData: "forged-init-data",
        playerId: "forged-player"
    };

    const cleaned = validateHandoffReadyPayload(withInjectedIdentity, NOW);

    assert.ok(cleaned, "identity noise must not break validation");
    assert.deepEqual(
        Object.keys(cleaned).sort(),
        ["expiresAt", "handoffId", "targetNetwork"],
        "the stored handoff record must contain ONLY the minimum fields"
    );

    console.log("  test 1 (minimal payload validation) passed");

}

// 2 — expiry check.

{

    const handoff = validateHandoffReadyPayload(VALID_PAYLOAD, NOW);

    assert.equal(isHandoffExpired(handoff, NOW), false);
    assert.equal(isHandoffExpired(handoff, NOW + 120_000), true);
    assert.equal(
        isHandoffExpired({ handoffId: HANDOFF_ID, expiresAt: null }, NOW),
        false,
        "expiry without a known expiresAt is delegated to the server TTL"
    );

    console.log("  test 2 (expiry check) passed");

}

// 3 — temporary persistence stores the minimum fields only.

{

    const storage = createFakeStorage();

    assert.equal(readHandoff(storage), null, "empty storage reads null");

    assert.equal(
        storeHandoff({ handoffId: HANDOFF_ID, targetNetwork: "mainnet", expiresAt: NOW + 1 }, storage),
        true,
        "storing a valid handoff must succeed"
    );

    const stored = JSON.parse(storage._map.get("wheelwin.roomNetworkHandoff"));

    assert.deepEqual(
        Object.keys(stored).sort(),
        ["expiresAt", "handoffId", "targetNetwork"],
        "the storage record must contain ONLY handoffId/targetNetwork/expiresAt"
    );

    assert.equal(readHandoff(storage)?.handoffId, HANDOFF_ID);

    assert.equal(
        storeHandoff({ initData: "forged", telegramUserId: "1" }, storage),
        false,
        "a handoff without a valid handoffId must not be stored"
    );

    clearHandoff(storage);

    assert.equal(readHandoff(storage), null, "clearHandoff must remove the record");

    console.log("  test 3 (minimum-field persistence) passed");

}

// 4 — deep link carries ONLY the opaque handoffId in startapp.

{

    const deepLink = buildMainnetDeepLink(HANDOFF_ID);

    assert.equal(
        deepLink,
        `https://t.me/wheel_win_bot?startapp=mainnet${HANDOFF_ID}`,
        "the deep link must use the operator-confirmed bot link with mainnet+handoffId"
    );

    const startappValue = deepLink.split("startapp=")[1];

    assert.ok(
        startappValue.length <= 64,
        "the startapp value must satisfy the Telegram 64-char limit"
    );

    assert.match(
        startappValue,
        /^[A-Za-z0-9_-]+$/,
        "the startapp value must use only Telegram-allowed characters"
    );

    assert.equal(
        startappValue.includes("initData"),
        false,
        "the deep link must never carry initData"
    );

    assert.equal(
        /telegramUserId|playerId|roomId=|walletAddress/.test(startappValue),
        false,
        "the deep link must never carry identity, player or room fields"
    );

    assert.equal(
        buildMainnetDeepLink("short"),
        null,
        "an invalid handoffId must not produce a deep link"
    );

    console.log("  test 4 (deep link carries only the handoffId) passed");

}

// 5 — start_param parsing is transport-only.

{

    assert.equal(
        readStartParamHandoff(`mainnet${HANDOFF_ID}`),
        HANDOFF_ID,
        "the mainnet+handoffId start_param must parse to the handoffId"
    );

    assert.equal(
        readStartParamHandoff("mainnet"),
        null,
        "the legacy plain mainnet launch must parse to null (normal direct-Mainnet session)"
    );

    assert.equal(
        readStartParamHandoff(`testnet${HANDOFF_ID}`),
        null,
        "foreign prefixes must parse to null"
    );

    assert.equal(
        readStartParamHandoff("mainnet forged id !!"),
        null,
        "forged payloads must parse to null"
    );

    assert.equal(
        readStartParamHandoff(null),
        null,
        "a missing start_param must parse to null"
    );

    assert.equal(
        readMainnetStartParam({
            Telegram: {
                WebApp: {
                    initDataUnsafe: {
                        start_param: `mainnet${HANDOFF_ID}`,
                        user: { id: 999 }
                    }
                }
            }
        }),
        `mainnet${HANDOFF_ID}`,
        "start_param must be readable from the Telegram context (transport only)"
    );

    assert.equal(
        hasTelegramInitData({
            Telegram: { WebApp: { initData: "fresh-signed-init-data" } }
        }),
        true,
        "fresh Telegram initData presence must be detectable"
    );

    assert.equal(
        hasTelegramInitData({ Telegram: { WebApp: { initData: "" } } }),
        false,
        "an unauthenticated context must not be treated as Telegram-authenticated"
    );

    console.log("  test 5 (transport-only start_param parsing) passed");

}

// 6 — launcher reuses the established R18 mechanism.

{

    const calls = { openTelegramLink: [], locationReplace: [] };

    const telegramWindow = {
        Telegram: {
            WebApp: {
                openTelegramLink: (url) => calls.openTelegramLink.push(url)
            }
        },
        location: { replace: (url) => calls.locationReplace.push(url) }
    };

    assert.equal(
        launchMainnetMiniApp(telegramWindow, HANDOFF_ID),
        "telegram",
        "Telegram runtime must launch via openTelegramLink"
    );

    assert.deepEqual(
        calls.openTelegramLink,
        [`https://t.me/wheel_win_bot?startapp=mainnet${HANDOFF_ID}`],
        "the Telegram handoff must carry the handoffId-only deep link"
    );

    assert.deepEqual(
        calls.locationReplace,
        [],
        "Telegram runtime must NOT use window.location.replace"
    );

    // Plain-browser fallback: no Telegram API → Mainnet web URL without any
    // handoff material in the URL.
    const browserWindow = {
        location: { replace: (url) => calls.locationReplace.push(url) }
    };

    assert.equal(
        launchMainnetMiniApp(browserWindow, HANDOFF_ID),
        "browser",
        "non-Telegram runtime must fall back to the Mainnet web URL"
    );

    assert.deepEqual(
        calls.locationReplace,
        ["https://wheelwin-main.vercel.app"],
        "the browser fallback must open the Mainnet origin without handoff material"
    );

    // No handoffId → no launch into a handoff-less Mainnet via Telegram.
    const calls2 = { openTelegramLink: [], locationReplace: [] };

    const telegramWindow2 = {
        Telegram: {
            WebApp: {
                openTelegramLink: (url) => calls2.openTelegramLink.push(url)
            }
        },
        location: { replace: (url) => calls2.locationReplace.push(url) }
    };

    launchMainnetMiniApp(telegramWindow2, null);

    assert.deepEqual(
        calls2.openTelegramLink,
        [],
        "a missing handoffId must never produce a handoff deep link"
    );

    assert.equal(
        isTestnetRuntime({ location: { hostname: "wheelwin-nine.vercel.app" } }),
        true,
        "the Testnet hostname family must be detected"
    );

    assert.equal(
        isTestnetRuntime({ location: { hostname: "wheelwin-main.vercel.app" } }),
        false,
        "the Mainnet hostname must not be detected as Testnet"
    );

    console.log("  test 6 (established launch mechanism reuse) passed");

}

console.log(
    "roomNetworkHandoff.test.js: all assertions passed"
);
