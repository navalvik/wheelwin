import { PAYMENT_RULES } from "../catalog/PaymentRules.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { calculateRequiredGram } from "./calculateRequiredGram.js";

function roundMoney(value) {

    return Math.round(Number(value) * 100) / 100;

}

/**
 * P6.4 — Build an immutable Game Contract snapshot from authoritative sources.
 * Values freeze at request time and must never change afterward.
 * P6.8A — ownerWallet is copied from OwnerConfiguration into the snapshot.
 */
export function buildGameContractSnapshot({
    gameId,
    roomId,
    playerIds,
    playerManager,
    sessionWalletStore,
    configuration = null,
    paymentRules = PAYMENT_RULES,
    ownerWallet = null
}) {

    if (!gameId || !roomId || !Array.isArray(playerIds) || playerIds.length === 0) {

        return null;

    }

    const resolvedOwnerWallet = ownerWallet
        ?? OwnerConfiguration.getOwnerWallet();

    if (!resolvedOwnerWallet) {

        return null;

    }

    const feeRate = Number(paymentRules.platformFeeRate) || 0.05;

    const winnerPercentage = roundMoney(1 - feeRate);

    const players = playerIds.map((playerId) => {

        const identity = playerManager.getIdentity(playerId);

        const configPlayer = configuration?.players?.find(
            (entry) => (
                String(entry.playerId) === String(playerId)
                || String(entry.ownerId) === String(playerId)
            )
        ) ?? null;

        const baseStake = Number(
            identity?.baseStake
            ?? configuration?.stake
            ?? 0
        );

        const sectorCount = Number(
            identity?.sectorCount
            ?? configPlayer?.sectorCount
            ?? 1
        ) === 2
            ? 2
            : 1;

        const requiredGram = calculateRequiredGram(baseStake, sectorCount) ?? 0;

        const wallet = sessionWalletStore?.getWallet?.(roomId, playerId) ?? null;

        const colors = [];

        const color = configPlayer?.color ?? identity?.color ?? null;

        const colorSector2 = configPlayer?.colorSector2
            ?? identity?.colorSector2
            ?? null;

        if (color) {

            colors.push(color);

        }

        if (sectorCount === 2 && colorSector2) {

            colors.push(colorSector2);

        }

        return Object.freeze({
            playerId,
            nickname: identity?.nickname ?? configPlayer?.nickname ?? null,
            wallet,
            baseStake,
            sectorCount,
            requiredGram,
            colors: Object.freeze(colors),
            icon: identity?.icon ?? configPlayer?.icon ?? null
        });

    });

    const totalPot = roundMoney(
        players.reduce((sum, player) => sum + Number(player.requiredGram), 0)
    );

    const organizerFee = roundMoney(totalPot * feeRate);

    const payoutAmount = roundMoney(totalPot - organizerFee);

    const sectors = Array.isArray(configuration?.sectors)
        ? configuration.sectors.map((sector) => Object.freeze({
            sectorId: sector.sectorId ?? null,
            ownerId: sector.ownerId ?? null,
            color: sector.color ?? null,
            colorId: sector.colorId ?? null,
            icon: sector.icon ?? null,
            angleStart: sector.angleStart ?? null,
            angleEnd: sector.angleEnd ?? null
        }))
        : Object.freeze([]);

    return Object.freeze({
        gameId,
        roomId,
        players: Object.freeze(players),
        sectors: Object.freeze(sectors),
        baseStake: Number(configuration?.stake ?? players[0]?.baseStake ?? 0),
        totalPot,
        organizerFee,
        payoutAmount,
        organizerFeeRate: feeRate,
        winnerPercentage,
        currency: "GRM",
        ownerWallet: resolvedOwnerWallet,
        frozenAt: Date.now()
    });

}
