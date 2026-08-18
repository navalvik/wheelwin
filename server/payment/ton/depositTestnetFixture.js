/**
 * R17.9L.14 — Deterministic TESTNET Deposit Contract fixture.
 * Public addresses only. No mnemonics, no production Deploy Wallet.
 */
import { Address } from "@ton/core";

import {
    DEPOSIT_CONTRACT_VERSION,
    DEPOSIT_NETWORK_TAG_TESTNET
} from "./buildDepositStateInit.js";

export const FROZEN_DEPOSIT_ARTIFACT_SHA256 =
    "2f624c71743a3c49dee47d98ebb19ea7b9a53d358ab14e3c696b8369d3e36fde";

export const FROZEN_DEPOSIT_CODE_CELL_HASH =
    "f82a36a598348f8b87267777dfe6966b15949ded7a24598e3da0c9d7b7ccda76";

export const FROZEN_DEPOSIT_EXPECTED_ADDRESS =
    "EQBKCT9nWRRpcrgBfdPCeWqZJTXC3iOh_pE_OSrP9lRmnr2A";

/** Public production Deploy Wallet pin — forbidden as R17.9L.14 sender. */
export const PRODUCTION_DEPLOY_WALLET =
    "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ";

export const TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV =
    "TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC";

export const TESTNET_DEPOSIT_DEPLOYER_EXPECTED_ADDRESS_ENV =
    "TON_TESTNET_DEPOSIT_DEPLOYER_EXPECTED_ADDRESS";

/** R17.9L.14D — Frozen dedicated W5 testnet deployer identity (public). */
export const FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS =
    "0QBSm-tvehArk8g8VybQEUpI83rI1IZozP3KUK8WdvMSjaIl";

export const FROZEN_TESTNET_DEPOSIT_DEPLOYER_ACCOUNT_ID =
    "529beb6f7a102b93c83c5726d0114a48f37ac8d48668ccfdca50af1676f3128d";

const ZERO_ADDRESS = new Address(0, Buffer.alloc(32));

export function getZeroDepositAddress() {

    return ZERO_ADDRESS.toString({ bounceable: true, urlSafe: true });

}

/**
 * Frozen testnet fixture. Reproducible. No player private keys.
 */
export const DEPOSIT_TESTNET_FIXTURE = Object.freeze({
    contractVersion: DEPOSIT_CONTRACT_VERSION,
    network: "testnet",
    networkTag: DEPOSIT_NETWORK_TAG_TESTNET,
    depositId: "dep_550e8400-e29b-41d4-a716-446655440014",
    roomId: "room-r179l14-deposit-fixture",
    gameId: "game-r179l14-deposit-fixture",
    player0: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
    player1: "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j",
    player2: "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi",
    expectedStake0: 10_000_000n,
    expectedStake1: 10_000_000n,
    expectedStake2: 10_000_000n,
    creationFeePerSeat: 1_000_000n,
    expiresAt: 2_000_000_000n,
    releaseAuthority: "EQAREREREREREREREREREREREREREREREREREREREREREeYT"
});

export function buildDepositTestnetStateInitParams(fixture = DEPOSIT_TESTNET_FIXTURE) {

    return {
        depositId: fixture.depositId,
        roomId: fixture.roomId,
        gameId: fixture.gameId,
        players: [
            {
                playerId: "seat0",
                wallet: fixture.player0,
                expectedStake: fixture.expectedStake0
            },
            {
                playerId: "seat1",
                wallet: fixture.player1,
                expectedStake: fixture.expectedStake1
            },
            {
                playerId: "seat2",
                wallet: fixture.player2,
                expectedStake: fixture.expectedStake2
            }
        ],
        creationFeePerSeat: fixture.creationFeePerSeat,
        expiresAt: fixture.expiresAt,
        network: fixture.network,
        releaseAuthority: fixture.releaseAuthority,
        contractVersion: fixture.contractVersion
    };

}

export function assertFixturePlayersDistinct(fixture = DEPOSIT_TESTNET_FIXTURE) {

    if (
        fixture.player0 === fixture.player1
        || fixture.player0 === fixture.player2
        || fixture.player1 === fixture.player2
    ) {

        throw new Error("Deposit testnet fixture players must be distinct");

    }

    if (fixture.releaseAuthority === PRODUCTION_DEPLOY_WALLET) {

        throw new Error("Deposit testnet releaseAuthority must not be Deploy Wallet");

    }

    return true;

}
