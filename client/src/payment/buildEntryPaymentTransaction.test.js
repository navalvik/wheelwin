import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    buildEntryPaymentTransaction,
    nanotonsToTonDisplay,
    sumAuthoritativeEntryNanotons,
    TON_CHAIN_ID_MAINNET,
    TON_CHAIN_ID_TESTNET,
    toTonConnectSendTransactionRequest
} from "./buildEntryPaymentTransaction.js";

const ROOM_WALLET = "EQDroomWalletPayToXXXXXXXXXXXXXXXXXX";
const LEGACY_CONTRACT = "EQBlegacyContractMustNeverReceivePlayerPayment";
const nowMs = 1_700_000_000_000;

describe("buildEntryPaymentTransaction — Room Wallet only", () => {
    it("creates exactly one plain TON transfer to the Room Wallet", () => {
        const tx = buildEntryPaymentTransaction({
            isCreator: true,
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            network: "testnet",
            depositAddress: "EQDlegacyDeposit",
            gameEscrowAddress: LEGACY_CONTRACT,
            paymentDestination: ROOM_WALLET,
            roomWalletAddress: ROOM_WALLET,
            requiredGram: 1,
            playerIndex: 2,
            nowMs
        });

        assert.equal(tx.messages.length, 1);
        assert.equal(tx.messages[0].address, ROOM_WALLET);
        assert.equal(tx.messages[0].amount, "1000000000");
        assert.equal(tx.messages[0].payload, undefined);
        assert.equal(tx.messages[0].stateInit, undefined);
        assert.equal(tx.totalNanotons, "1000000000");
        assert.equal(tx.validUntil, Math.floor(nowMs / 1000) + 600);
        assert.equal(tx.network, TON_CHAIN_ID_TESTNET);
    });

    it("never uses GameEscrow or DepositContract addresses", () => {
        const tx = buildEntryPaymentTransaction({
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            network: "testnet",
            depositAddress: "EQDlegacyDeposit",
            gameEscrowAddress: LEGACY_CONTRACT,
            paymentDestination: ROOM_WALLET,
            requiredGram: 2.5,
            playerIndex: 0,
            nowMs
        });

        assert.equal(tx.messages.length, 1);
        assert.equal(tx.messages[0].address, ROOM_WALLET);
        assert.notEqual(tx.messages[0].address, LEGACY_CONTRACT);
        assert.notEqual(tx.messages[0].address, "EQDlegacyDeposit");
    });

    it("fails closed when the Room Wallet destination is missing", () => {
        assert.throws(
            () => buildEntryPaymentTransaction({
                includeStake: true,
                network: "testnet",
                gameEscrowAddress: LEGACY_CONTRACT,
                requiredGram: 1,
                playerIndex: 0,
                nowMs
            }),
            /Room Wallet address is required/
        );
    });

    it("ignores legacy deploy/fund inputs instead of constructing contract messages", () => {
        const tx = buildEntryPaymentTransaction({
            includeDeploy: true,
            includeFund: true,
            includeStake: true,
            depositPackage: {
                stateInit: { codeBoc: "legacy", dataBoc: "legacy" },
                deployValueNanotons: "10000000"
            },
            depositAddress: "EQDlegacyDeposit",
            mySeatIndex: 0,
            myExpectedAmountNanotons: "11000000",
            network: "testnet",
            paymentDestination: ROOM_WALLET,
            requiredGram: 0.01,
            playerIndex: 0,
            nowMs
        });

        assert.equal(tx.messages.length, 1);
        assert.equal(tx.messages[0].address, ROOM_WALLET);
        assert.equal(tx.messages[0].amount, "10000000");
        assert.equal(tx.messages[0].stateInit, undefined);
        assert.equal(tx.messages[0].payload, undefined);
    });

    it("TonConnect payload contains only SDK transaction fields", () => {
        const tx = buildEntryPaymentTransaction({
            includeStake: true,
            network: "testnet",
            roomWalletAddress: ROOM_WALLET,
            requiredGram: 1,
            nowMs
        });

        const sent = toTonConnectSendTransactionRequest(tx);

        assert.deepEqual(
            Object.keys(sent).sort(),
            ["messages", "network", "validUntil"]
        );
        assert.deepEqual(
            Object.keys(sent.messages[0]).sort(),
            ["address", "amount"]
        );
        assert.equal(sent.network, TON_CHAIN_ID_TESTNET);
    });

    it("maps the authoritative testnet session network to TonConnect chain id -3", () => {
        const tx = buildEntryPaymentTransaction({
            includeStake: true,
            network: "testnet",
            roomWalletAddress: ROOM_WALLET,
            requiredGram: 1,
            nowMs
        });

        assert.equal(tx.network, "-3");

        const sent = toTonConnectSendTransactionRequest(tx);

        assert.equal(sent.network, "-3");
        assert.equal(sent.network, TON_CHAIN_ID_TESTNET);
    });

    it("maps the authoritative mainnet session network to TonConnect chain id -239", () => {
        const tx = buildEntryPaymentTransaction({
            includeStake: true,
            network: "mainnet",
            roomWalletAddress: ROOM_WALLET,
            requiredGram: 1,
            nowMs
        });

        assert.equal(tx.network, "-239");

        const sent = toTonConnectSendTransactionRequest(tx);

        assert.equal(sent.network, "-239");
        assert.equal(sent.network, TON_CHAIN_ID_MAINNET);
    });

    it("fails closed when the authoritative network is missing", () => {
        assert.throws(
            () => buildEntryPaymentTransaction({
                includeStake: true,
                network: null,
                roomWalletAddress: ROOM_WALLET,
                requiredGram: 1,
                nowMs
            }),
            /Authoritative payment session network is required/
        );

        assert.throws(
            () => buildEntryPaymentTransaction({
                includeStake: true,
                roomWalletAddress: ROOM_WALLET,
                requiredGram: 1,
                nowMs
            }),
            /Authoritative payment session network is required/
        );
    });

    it("fails closed when the authoritative network is invalid", () => {
        for (const network of ["TESTNET", "Mainnet", "goerli", "", "testnet "]) {

            assert.throws(
                () => buildEntryPaymentTransaction({
                    includeStake: true,
                    network,
                    roomWalletAddress: ROOM_WALLET,
                    requiredGram: 1,
                    nowMs
                }),
                /Authoritative payment session network is required/
            );

        }
    });

    it("REGRESSION: a Testnet payment request cannot be built without an explicit Testnet network", () => {
        // The builder must refuse to construct anything without the
        // server-authoritative network.
        assert.throws(
            () => buildEntryPaymentTransaction({
                includeStake: true,
                network: null,
                roomWalletAddress: ROOM_WALLET,
                requiredGram: 1,
                nowMs
            }),
            /Authoritative payment session network is required/
        );

        // Even a hand-built transaction object must never reach the wallet
        // without an explicit authoritative chain id on the request.
        assert.throws(
            () => toTonConnectSendTransactionRequest({
                validUntil: Math.floor(nowMs / 1000) + 600,
                messages: [{ address: ROOM_WALLET, amount: "1000000000" }]
            }),
            /TonConnect transaction requires an explicit authoritative network/
        );
    });

    it("keeps the TonConnect validUntil behaviour unchanged", () => {
        const tx = buildEntryPaymentTransaction({
            includeStake: true,
            network: "testnet",
            roomWalletAddress: ROOM_WALLET,
            requiredGram: 1,
            validUntilSeconds: 300,
            nowMs
        });

        assert.equal(tx.validUntil, Math.floor(nowMs / 1000) + 300);

        const sent = toTonConnectSendTransactionRequest(tx);

        assert.equal(sent.validUntil, tx.validUntil);
    });

    it("keeps authoritative amount helpers independent of payment routing", () => {
        assert.equal(nanotonsToTonDisplay("1000000000"), "1");
        assert.equal(
            sumAuthoritativeEntryNanotons({
                stakeNanotons: "1000000000"
            }),
            "1000000000"
        );
    });
});
