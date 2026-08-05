/**
 * R6.x — canonicalizeTonWalletAddress uses official TON parser only.
 */

import assert from "node:assert/strict";

import { Address } from "@ton/core";

import {
    canonicalizeTonWalletAddress,
    sessionWalletsMatch
} from "../models/TonWalletAddress.js";

import {
    WALLET_CONNECTION_STATUS,
    WalletConnectionSession
} from "../models/WalletConnectionSession.js";

const ZERO = Address.parse(
    "0:0000000000000000000000000000000000000000000000000000000000000000"
);

const raw = "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const friendly = Address.parse(raw).toString({
    bounceable: true,
    urlSafe: true
});

const uq = ZERO.toString({ bounceable: false, urlSafe: true, testOnly: false });

const kq = ZERO.toString({ bounceable: true, urlSafe: true, testOnly: true });

const zq = ZERO.toString({ bounceable: false, urlSafe: true, testOnly: true });

const eq = ZERO.toString({ bounceable: true, urlSafe: true, testOnly: false });

assert.equal(canonicalizeTonWalletAddress(friendly), friendly);

assert.equal(canonicalizeTonWalletAddress(uq), eq);

assert.equal(canonicalizeTonWalletAddress(kq), eq);

assert.equal(canonicalizeTonWalletAddress(zq), eq);

assert.equal(canonicalizeTonWalletAddress("EQ123"), null);

assert.equal(canonicalizeTonWalletAddress("ABCDEF"), null);

assert.equal(canonicalizeTonWalletAddress(""), null);

assert.equal(
    sessionWalletsMatch(friendly, raw),
    true,
    "raw and EQ forms of the same address must match"
);

assert.equal(
    sessionWalletsMatch(uq, eq),
    true,
    "UQ and EQ forms of the same address must match"
);

assert.equal(
    sessionWalletsMatch(friendly, "EQnot-the-same-wallet-address-xxxxxxxxxxxx"),
    false
);

const session = WalletConnectionSession.createInitial("room-1", [
    { playerId: "p1", sessionWallet: friendly },
    { playerId: "p2", sessionWallet: friendly },
    { playerId: "p3", sessionWallet: friendly }
]);

assert.equal(session.players[0].status, WALLET_CONNECTION_STATUS.WAITING);

session.setConnecting("p1");

assert.equal(session.players[0].status, WALLET_CONNECTION_STATUS.CONNECTING);

session.setConnected("p1", friendly);

assert.equal(session.players[0].status, WALLET_CONNECTION_STATUS.CONNECTED);

assert.equal(session.paymentConnectionReady, false);

session.setConnected("p2", friendly);

session.setConnected("p3", friendly);

assert.equal(session.paymentConnectionReady, true);

session.setWaiting("p2");

assert.equal(session.players[1].status, WALLET_CONNECTION_STATUS.WAITING);

assert.equal(session.paymentConnectionReady, false);

session.setAddressMismatch("p2", eq);

assert.equal(
    session.players[1].status,
    WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
);

// R7.26 — WAITING → CONNECTED without CONNECTING (restored SDK session).
const restored = WalletConnectionSession.createInitial("room-restored", [
    { playerId: "r1", sessionWallet: friendly },
    { playerId: "r2", sessionWallet: friendly },
    { playerId: "r3", sessionWallet: friendly }
]);

assert.equal(restored.players[0].status, WALLET_CONNECTION_STATUS.WAITING);

assert.equal(
    restored.setConnected("r1", friendly),
    true,
    "WAITING → CONNECTED must succeed without setConnecting"
);

assert.equal(restored.players[0].status, WALLET_CONNECTION_STATUS.CONNECTED);

assert.equal(restored.players[0].connectedWallet, friendly);

console.log("walletConnection.session.test.js: all assertions passed");
