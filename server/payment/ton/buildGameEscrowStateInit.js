import { createHash } from "node:crypto";

import { Address } from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

/**
 * P6.6 — Deterministic Game Escrow wallet from immutable snapshot.
 * Each game gets a unique WalletContractV4 address derived from snapshot hash.
 */
export function hashGameContractSnapshot(snapshot) {

    const payload = JSON.stringify({
        gameId: snapshot?.gameId ?? null,
        roomId: snapshot?.roomId ?? null,
        totalPot: snapshot?.totalPot ?? null,
        organizerFee: snapshot?.organizerFee ?? null,
        players: (snapshot?.players ?? []).map((player) => ({
            playerId: player.playerId,
            wallet: player.wallet,
            requiredGram: player.requiredGram
        }))
    });

    return createHash("sha256").update(payload).digest();

}

export function buildGameEscrowWallet({ contractId, snapshot }) {

    const snapshotHash = hashGameContractSnapshot(snapshot);

    // Mix contractId so redeploys of identical snapshots stay unique per id.
    const seed = createHash("sha256")
        .update(Buffer.concat([
            snapshotHash,
            Buffer.from(String(contractId))
        ]))
        .digest();

    const keyPair = keyPairFromSeed(seed);

    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    });

    return {
        wallet,
        keyPair,
        address: wallet.address,
        addressFriendly: wallet.address.toString({
            bounceable: true,
            urlSafe: true
        }),
        snapshotHash: snapshotHash.toString("hex"),
        stateInit: wallet.init
    };

}

export function parseFriendlyAddress(raw) {

    if (typeof raw !== "string" || !raw.trim()) {

        return null;

    }

    try {

        return Address.parse(raw.trim());

    } catch {

        return null;

    }

}
