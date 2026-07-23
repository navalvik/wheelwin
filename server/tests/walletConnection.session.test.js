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

const raw = "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const friendly = Address.parse(raw).toString({
    bounceable: true,
    urlSafe: true
});

assert.equal(canonicalizeTonWalletAddress(friendly), friendly);

assert.equal(
    sessionWalletsMatch(friendly, raw),
    true,
    "raw and EQ forms of the same address must match"
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

session.setAddressMismatch("p2", "EQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

assert.equal(
    session.players[1].status,
    WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH
);

console.log("walletConnection.session.test.js: all assertions passed");
