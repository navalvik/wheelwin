/**
 * Composition root for the Room Wallet payment subsystem.
 *
 * This service wires the runtime resolver, registry, TON transport adapter and
 * settlement adapter without changing WheelWin gameplay or settlement math.
 *
 * PAYOUT GAS POLICY: Winner/Owner payouts and player refunds are
 * RECIPIENT_PAYS_GAS transfers (the recipient gas charge is deducted from the
 * authoritative gross payout before broadcast). The recipient gas safety
 * margin is configurable via environment with strict fail-closed validation:
 * - ROOM_WALLET_RECIPIENT_GAS_MARGIN_BPS        (default 2000 = 20%)
 * - ROOM_WALLET_RECIPIENT_GAS_MARGIN_FLOOR_NANO (default 1000000 = 0.001 GRAM)
 * Invalid values must not silently degrade the policy: they fail startup.
 */

import { RoomWalletAdapter } from "./RoomWalletAdapter.js";
import { RoomWalletOutboundIntentJournal } from "./RoomWalletOutboundIntentJournal.js";
import { RoomWalletSingleWriterGate } from "./RoomWalletSingleWriterGate.js";
import { RoomWalletGuardedOutboundExecutor } from "./RoomWalletGuardedOutboundExecutor.js";
import { RoomWalletGuardedPayoutCoordinator } from "./RoomWalletGuardedPayoutCoordinator.js";
import { RoomWalletRefundRecoveryRepository } from "./RoomWalletRefundRecoveryRepository.js";
import { RoomWalletResidualSweepRepository } from "./RoomWalletResidualSweepRepository.js";
import {
    createRoomWalletRuntimeResolver,
    createRoomWalletRegistryFromEnv
} from "./RoomWalletRuntimeResolver.js";
import { RoomWalletSettlementAdapter } from "./RoomWalletSettlementAdapter.js";
import { ROOM_WALLET_POLICY } from "./RoomWalletFinancialPolicy.js";

function parseRecipientGasMarginEnv(env) {
    const marginBpsRaw = String(env?.ROOM_WALLET_RECIPIENT_GAS_MARGIN_BPS ?? "").trim();
    const marginFloorRaw = String(env?.ROOM_WALLET_RECIPIENT_GAS_MARGIN_FLOOR_NANO ?? "").trim();

    let marginBps = ROOM_WALLET_POLICY.recipientGasMarginBps;
    let marginFloorNano = ROOM_WALLET_POLICY.recipientGasMarginFloorNano;

    if (marginBpsRaw !== "") {
        if (!/^\d+$/.test(marginBpsRaw)) {
            throw new TypeError(
                "ROOM_WALLET_RECIPIENT_GAS_MARGIN_BPS must be a non-negative integer"
            );
        }
        marginBps = BigInt(marginBpsRaw);
    }

    if (marginFloorRaw !== "") {
        if (!/^\d+$/.test(marginFloorRaw)) {
            throw new TypeError(
                "ROOM_WALLET_RECIPIENT_GAS_MARGIN_FLOOR_NANO must be a non-negative integer"
            );
        }
        marginFloorNano = BigInt(marginFloorRaw);
    }

    return {
        ...(marginBps === ROOM_WALLET_POLICY.recipientGasMarginBps ? {} : { recipientGasMarginBps: marginBps }),
        ...(
            marginFloorNano === ROOM_WALLET_POLICY.recipientGasMarginFloorNano
                ? {}
                : { recipientGasMarginFloorNano: marginFloorNano }
        )
    };
}

export function createRoomWalletService({
    tonService,
    logger = null,
    env = process.env,
    gasReserveNano = undefined,
    financialPersistence = null,
    signerLockDirectory = null
} = {}) {
    if (!tonService) {
        throw new Error("createRoomWalletService requires tonService");
    }

    const guardedOnly = String(env?.ROOM_WALLET_GUARDED_OUTBOUND_ONLY ?? "")
        .trim().toLowerCase() === "true";
    if (guardedOnly) {
        if (String(env?.TON_NETWORK ?? "").trim().toLowerCase() !== "testnet") {
            throw new Error("GUARDED_OUTBOUND_TESTNET_ONLY");
        }
        if (String(env?.ROOM_WALLET_OUTGOING_CONFIRMATION_ENABLED ?? "")
                .trim().toLowerCase() !== "true"
            || String(env?.ROOM_WALLET_EXPIRED_RECONCILIATION_ENABLED ?? "")
                .trim().toLowerCase() !== "true") {
            // No live outgoing sends without restart-safe independent
            // confirmation and expired-payment debt recovery workers.
            throw new Error("GUARDED_OUTBOUND_REQUIRES_RECOVERY_WORKERS");
        }
        if (!financialPersistence
            || typeof signerLockDirectory !== "string"
            || signerLockDirectory.trim().length === 0
            || typeof tonService.broadcastTransaction !== "function"
            || typeof tonService.getSeqno !== "function") {
            throw new Error("GUARDED_OUTBOUND_REQUIRES_SHARED_STORE_AND_SIGNER");
        }
    }
    const registry = createRoomWalletRegistryFromEnv(env);
    const walletResolver = createRoomWalletRuntimeResolver({ env, registry });
    const roomWalletAdapter = new RoomWalletAdapter({
        tonService,
        walletResolver,
        logger,
        // Default OFF until ALL refund/winner/owner/residual-sweep routes use
        // the durable signer. Once enabled, legacy direct sends hard-fail.
        guardedOutboundOnly: guardedOnly,
        ...(gasReserveNano === undefined ? {} : { gasReserveNano })
    });
    let guardedPayoutCoordinator = null;
    if (guardedOnly) {
        const journal = new RoomWalletOutboundIntentJournal({
            financialPersistence, roomWalletRegistry: registry
        });
        const walletGate = new RoomWalletSingleWriterGate({
            directory: signerLockDirectory,
            intentJournal: journal
        });
        const executor = new RoomWalletGuardedOutboundExecutor({
            intentJournal: journal,
            walletGate,
            signer: roomWalletAdapter,
            broadcaster: {
                // This is the ONLY RPC broadcast in the protected path.
                // Sender construction cannot be duplicated by a caller.
                broadcastSignedBoc: (boc) => tonService.broadcastTransaction(boc)
            },
            chain: tonService,
            enabled: true
        });
        guardedPayoutCoordinator = new RoomWalletGuardedPayoutCoordinator({
            journal, executor,
            financialPersistence,
            refundRecoveryRepository: new RoomWalletRefundRecoveryRepository({
                financialPersistence
            }),
            residualSweepRepository: new RoomWalletResidualSweepRepository({
                persistence: financialPersistence,
                tonNetwork: "testnet"
            })
        });
    }
    const settlementAdapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter,
        guardedPayoutCoordinator,
        logger,
        ...parseRecipientGasMarginEnv(env)
    });

    return Object.freeze({
        registry,
        walletResolver,
        roomWalletAdapter,
        settlementAdapter,
        guardedPayoutCoordinator,
        isConfigured() {
            return registry.size() > 0;
        }
    });
}
