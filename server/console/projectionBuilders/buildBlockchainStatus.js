/**
 * R6.2 — Blockchain status DTO (read-only diagnostics).
 * R7.51.29 — includes last TON deploy attempt snapshot (no secrets).
 */
import { getTonDeployDebug } from "../../diagnostics/DeployPipelineForensics.js";
import {
    mapManagerStatus,
    mapMonitorStatus,
    mapRecoveryStatus,
    mapTonServiceStatus
} from "./serviceStatus.js";

export function buildBlockchainStatus({
    runtimeConfig = null,
    tonService = null,
    blockchainMonitor = null,
    walletManager = null,
    gameContractManager = null,
    paymentSessionManager = null,
    contractSettlementManager = null,
    tonFinancialRecovery = null
}) {

    const tonHealth = tonService?.health?.() ?? null;

    const monitorHealth = blockchainMonitor?.health?.() ?? null;

    const walletHealth = walletManager?.health?.() ?? null;

    const paymentHealth = paymentSessionManager?.health?.() ?? null;

    const settlementHealth = contractSettlementManager?.health?.() ?? null;

    const recoverySnapshot = tonFinancialRecovery?.getDashboardSnapshot?.() ?? null;

    const network = runtimeConfig?.ton?.network
        ?? tonHealth?.network
        ?? monitorHealth?.network
        ?? "unknown";

    const connectionStatus = tonHealth?.connected === true
        ? "Connected"
        : (tonHealth ? "Disconnected" : "Unknown");

    const tonDeployDebug = getTonDeployDebug();

    return Object.freeze({
        network,
        connectionStatus,
        deployMode: runtimeConfig?.ton?.deployMode ?? null,
        tonDeployDebug,
        services: Object.freeze({
            tonService: Object.freeze({
                status: mapTonServiceStatus(tonHealth),
                connected: tonHealth?.connected === true,
                endpointConfigured: Boolean(runtimeConfig?.ton?.endpointConfigured),
                latencyMs: tonHealth?.latency ?? null
            }),
            blockchainMonitor: Object.freeze({
                status: mapMonitorStatus(monitorHealth),
                state: monitorHealth?.state ?? null,
                watchedContracts: monitorHealth?.watchedContracts ?? 0,
                pendingTransactions: monitorHealth?.pendingTransactions ?? 0
            }),
            walletManager: Object.freeze({
                status: mapManagerStatus(walletHealth, {
                    initialized: walletManager != null
                }),
                activeSessions: walletHealth?.activeSessions ?? 0,
                verifiedWallets: walletHealth?.verifiedWallets ?? 0
            }),
            contractManager: Object.freeze({
                status: mapManagerStatus(
                    gameContractManager ? { ok: true } : null,
                    { initialized: gameContractManager != null }
                ),
                trackedRooms: gameContractManager?.listContractRoomIds?.()?.length ?? 0
            }),
            paymentSessionManager: Object.freeze({
                status: mapManagerStatus(paymentHealth, {
                    initialized: paymentSessionManager != null
                }),
                activeSessions: paymentHealth?.activeSessions ?? 0,
                pendingPayments: paymentHealth?.pendingPayments ?? 0
            }),
            contractSettlementManager: Object.freeze({
                status: mapManagerStatus(settlementHealth, {
                    initialized: contractSettlementManager != null
                }),
                activeSettlements: settlementHealth?.activeSettlements ?? 0,
                pendingSettlements: settlementHealth?.pendingSettlements ?? 0
            }),
            tonFinancialRecovery: Object.freeze({
                status: mapRecoveryStatus(recoverySnapshot, {
                    initialized: tonFinancialRecovery != null
                }),
                state: recoverySnapshot?.state ?? null,
                currentPhase: recoverySnapshot?.currentPhase ?? null
            })
        })
    });

}
