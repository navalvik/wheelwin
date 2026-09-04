/**
 * Deterministic dummy Room Wallet fixtures for tests.
 * Not production identities. Never log secretKey.
 */
import { createHash } from "node:crypto";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

export function createDummyRoomWalletEntry(roomNumber, {
    network = "testnet",
    workchain = 0,
    seedLabel = `wheelwin-test-room-wallet-${roomNumber}`
} = {}) {
    const seed = createHash("sha256").update(String(seedLabel)).digest();
    const keyPair = keyPairFromSeed(seed);
    const wallet = WalletContractV4.create({
        workchain,
        publicKey: keyPair.publicKey
    });

    return {
        roomNumber,
        address: wallet.address.toString({ bounceable: true, urlSafe: true }),
        publicKey: Buffer.from(keyPair.publicKey).toString("hex"),
        secretKey: Buffer.from(keyPair.secretKey).toString("hex"),
        workchain,
        network
    };
}

export function createDummyRoomWalletCatalog(count = 64, options = {}) {
    return Array.from({ length: count }, (_, index) => (
        createDummyRoomWalletEntry(index + 1, options)
    ));
}
