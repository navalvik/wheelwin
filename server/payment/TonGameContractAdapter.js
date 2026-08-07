/**
 * T2.3 — Production TON Game Smart Contract adapter.
 *
 * Owns contract ABI encoding/decoding. Communicates only with TonService.
 * Gameplay modules never import @ton/* except through this adapter boundary.
 */

import { Address, beginCell, external, internal, storeMessage, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    beginTonDeployDebug,
    markDeployStage,
    printDeployBlock,
    printGameEscrowDeployDebug,
    pushTonDeployDebugStage,
    safeSerialize,
    setGameEscrowDeployDebug
} from "../diagnostics/DeployPipelineForensics.js";
import {
    printGameEscrowSettlementDebug,
    setGameEscrowSettlementDebug
} from "../diagnostics/SettlementPipelineForensics.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import {
    GAME_ESCROW_MODE_GAME,
    buildGameEscrowWallet,
    resolveGameEscrowMode
} from "./ton/buildGameEscrowStateInit.js";
import { buildSettleMessagePlan } from "./ton/buildSettleMessagePlan.js";
import {
    assertNetworkCompatibility,
    parseContractAddress
} from "./ton/gameContract/GameContractAddress.js";
import {
    decodeArchiveState,
    decodeBalances,
    decodeContractState,
    decodePaidMask,
    decodeParticipants,
    decodePlayerPayment,
    decodeRequiredTotal,
    decodeSettlementState,
    decodeTotalPaid,
    decodeWinner,
    decodeNetwork
} from "./ton/gameContract/GameContractDeserializer.js";
import {
    createDeployResultDTO,
    createOperationResultDTO
} from "./ton/gameContract/GameContractDtos.js";
import {
    ContractNotFoundError
} from "./ton/gameContract/GameContractErrors.js";
import { GAME_CONTRACT_GET_METHODS } from "./ton/gameContract/GameContractOpcodes.js";
import {
    serializeArchiveBody,
    serializeDeployBocPlaceholder,
    serializeEmergencyCancelBody,
    serializeGameEscrowInitGameBody,
    serializeGameEscrowOpenPaymentsBody,
    serializeSettleBocPlaceholder
} from "./ton/gameContract/GameContractSerializer.js";
import { createLegacyTonServiceShim } from "./ton/gameContract/legacyTonServiceShim.js";

const DEFAULT_ESCROW_ACTIVATION_TIMEOUT_MS = 60_000;
const DEFAULT_DEPLOY_VALUE_TON = "0.05";

function sleep(ms) {

    return new Promise((resolve) => {

        setTimeout(resolve, ms);

    });

}

function addressToFriendly(address) {

    if (!address) {

        return null;

    }

    if (typeof address === "string") {

        return address;

    }

    try {

        return address.toString({
            bounceable: true,
            urlSafe: true
        });

    } catch {

        return String(address);

    }

}

function cellHashHex(cell) {

    if (!cell || typeof cell.hash !== "function") {

        return null;

    }

    try {

        return cell.hash().toString("hex");

    } catch {

        return null;

    }

}

export class TonGameContractAdapter {

    constructor({
        logger = null,
        tonConfig,
        tonService = null,
        transport = null,
        tonClient = null
    }) {

        this._logger = logger;

        this._tonConfig = tonConfig;

        this._tonService = tonService;

        this._legacyTransport = transport;

        this._legacyTonClient = tonClient;

        this._legacyShim = null;

    }

    // -------------------------------------------------------------------------
    // Legacy API (GameContractManager / ContractSettlementManager)
    // -------------------------------------------------------------------------

    async deploy({ contractId, snapshot }) {

        printDeployBlock("ADAPTER DEPLOY ENTRY (TonGameContractAdapter.deploy)", {
            AdapterImplementation: "TonGameContractAdapter (live)",
            ContractId: contractId,
            RoomId: snapshot?.roomId ?? null,
            GameId: snapshot?.gameId ?? null,
            Timestamp: new Date().toISOString()
        });

        const result = await this.deployContract({ contractId, snapshot });

        const mapped = {
            ok: result.ok,
            contractAddress: result.contractAddress,
            deploymentTxId: result.deploymentTxId,
            deployedAt: result.deployedAt,
            snapshotHash: result.snapshotHash,
            reason: result.reason
        };

        printDeployBlock("ADAPTER DEPLOY RETURN (TonGameContractAdapter.deploy)", {
            Case: mapped.ok ? "A — ok:true" : "B — ok:false",
            ReturnedObject: safeSerialize(mapped),
            ReturnedPromise: "resolved (not rejected)",
            Timestamp: new Date().toISOString()
        });

        return mapped;

    }

    async settleContract(settlementRequest) {

        const result = await this.settle(settlementRequest);

        return {
            ok: result.ok,
            settlementTxId: result.txId,
            settledAt: result.completedAt,
            reason: result.reason
        };

    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    async deployContract({ contractId, snapshot }) {

        const roomId = snapshot?.roomId ?? contractId;
        const stage = markDeployStage(roomId, "ADAPTER_LIVE_DEPLOY_CONTRACT_START");

        printDeployBlock("ADAPTER deployContract START (TonGameContractAdapter)", {
            AdapterImplementation: "TonGameContractAdapter",
            Environment: process.env.NODE_ENV ?? "unknown",
            DeployMode: "live",
            Network: this._tonConfig?.network ?? "unknown",
            Railway: Boolean(process.env.RAILWAY_ENVIRONMENT),
            Development: process.env.NODE_ENV !== "production",
            CanBroadcast: this._canBroadcast(),
            DeployerMnemonicConfigured: Boolean(this._tonConfig?.deployerMnemonic),
            RpcEndpoint: this._tonConfig?.endpoint ?? null,
            ContractId: contractId,
            RoomId: snapshot?.roomId ?? null,
            GameId: snapshot?.gameId ?? null,
            DurationSincePreviousStageMs: stage.elapsedMs,
            Timestamp: new Date(stage.now).toISOString()
        });

        if (!contractId || !snapshot) {

            const result = createDeployResultDTO({
                ok: false,
                reason: "invalid_deploy_request"
            });

            printDeployBlock("ADAPTER deployContract RETURN", {
                Case: "B — ok:false",
                ReturnedObject: safeSerialize(result),
                Timestamp: new Date().toISOString()
            });

            return result;

        }

        try {

            const gameEscrowMode = resolveGameEscrowMode(
                this._tonConfig?.gameEscrowMode
            );

            const deployValueTon = DEFAULT_DEPLOY_VALUE_TON;

            const escrow = buildGameEscrowWallet({
                contractId,
                snapshot,
                mode: gameEscrowMode,
                oracle: snapshot?.oracleWallet
                    ?? snapshot?.oracle
                    ?? this._tonConfig?.oracleAddress
                    ?? null,
                owner: snapshot?.ownerWallet
                    ?? this._tonConfig?.ownerWallet
                    ?? null
            });

            const contractAddress = escrow.addressFriendly;

            let deploymentTxId = null;

            let deployedAt = Date.now();

            // R7.51.29 — diagnostics only (no secrets).
            beginTonDeployDebug({
                roomId: snapshot?.roomId ?? null,
                gameId: snapshot?.gameId ?? null,
                escrowAddress: contractAddress,
                valueTon: deployValueTon
            });

            // R7.66E — GameEscrow deploy diagnostics (v4 or game).
            const gameEscrowDebug = {
                mode: escrow.mode ?? gameEscrowMode,
                contractAddress,
                codeHash: cellHashHex(escrow.stateInit?.code ?? escrow.code),
                dataHash: cellHashHex(escrow.stateInit?.data ?? escrow.data),
                oracle: addressToFriendly(escrow.oracle),
                owner: addressToFriendly(escrow.owner),
                transactionHash: null,
                valueTon: deployValueTon,
                snapshotHash: escrow.snapshotHash ?? null
            };

            setGameEscrowDeployDebug(gameEscrowDebug);
            printGameEscrowDeployDebug(gameEscrowDebug);

            if (this._canBroadcast()) {

                printDeployBlock("ADAPTER RPC — broadcastDeploy START", {
                    ContractAddress: contractAddress,
                    GameEscrowMode: gameEscrowMode,
                    DeployerAddress: "(resolved at broadcast)",
                    RpcEndpoint: this._tonConfig?.endpoint ?? null,
                    RequestPayload: safeSerialize({
                        contractId,
                        to: contractAddress,
                        valueTon: deployValueTon,
                        mode: gameEscrowMode,
                        hasCode: Boolean(escrow.stateInit?.code),
                        hasData: Boolean(escrow.stateInit?.data)
                    }),
                    Timestamp: new Date().toISOString()
                });

                const broadcast = await this._broadcastDeploy(escrow);

                printDeployBlock("ADAPTER RPC — broadcastDeploy RESPONSE", {
                    ResponsePayload: safeSerialize(broadcast),
                    "broadcast.ok": broadcast?.ok,
                    Timestamp: new Date().toISOString()
                });

                if (!broadcast.ok) {

                    const result = createDeployResultDTO({
                        ok: false,
                        reason: broadcast.reason ?? "deploy_failed"
                    });

                    printDeployBlock("ADAPTER deployContract RETURN", {
                        Case: "B — ok:false (broadcast failed)",
                        FailReason: result.reason,
                        ReturnedObject: safeSerialize(result),
                        Timestamp: new Date().toISOString()
                    });

                    return result;

                }

                deploymentTxId = broadcast.deploymentTxId;

                deployedAt = broadcast.deployedAt ?? deployedAt;

                setGameEscrowDeployDebug({
                    transactionHash: deploymentTxId
                });
                printGameEscrowDeployDebug();

                printDeployBlock("ADAPTER RPC — waitUntilEscrowActive START", {
                    ContractAddress: contractAddress,
                    PollIntervalMs: this._tonConfig?.pollIntervalMs ?? 2000,
                    EscrowActivationTimeoutMs:
                        this._tonConfig?.escrowActivationTimeoutMs ?? 60000,
                    Timestamp: new Date().toISOString()
                });

                const activation = await this._waitUntilEscrowActive(
                    contractAddress
                );

                printDeployBlock("ADAPTER RPC — waitUntilEscrowActive RESPONSE", {
                    ResponsePayload: safeSerialize(activation),
                    "activation.ok": activation?.ok,
                    Timestamp: new Date().toISOString()
                });

                if (!activation.ok) {

                    const result = createDeployResultDTO({
                        ok: false,
                        reason: activation.reason ?? "escrow_activation_failed"
                    });

                    printDeployBlock("ADAPTER deployContract RETURN", {
                        Case: "B — ok:false (activation failed)",
                        FailReason: result.reason,
                        ReturnedObject: safeSerialize(result),
                        Timestamp: new Date().toISOString()
                    });

                    return result;

                }

            } else {

                printDeployBlock("ADAPTER RPC — no-broadcast placeholder path", {
                    Reason: "deployerMnemonic not configured",
                    GameEscrowMode: gameEscrowMode,
                    RpcEndpoint: this._tonConfig?.endpoint ?? null,
                    Timestamp: new Date().toISOString()
                });

                await this._service().broadcastTransaction(
                    serializeDeployBocPlaceholder({ contractId })
                );

                deploymentTxId = `ton_addr_${escrow.snapshotHash.slice(0, 16)}`;

                setGameEscrowDeployDebug({
                    transactionHash: deploymentTxId
                });
                printGameEscrowDeployDebug();

            }

            this._logInfo(
                `TON GameContract deployed | contractId=${contractId} | `
                    + `mode=${gameEscrowMode} | address=${contractAddress}`
            );

            const result = createDeployResultDTO({
                ok: true,
                contractAddress,
                deploymentTxId,
                deployedAt,
                snapshotHash: escrow.snapshotHash
            });

            printDeployBlock("ADAPTER deployContract RETURN", {
                Case: "A — ok:true",
                GameEscrowMode: gameEscrowMode,
                ReturnedObject: safeSerialize(result),
                Timestamp: new Date().toISOString()
            });

            return result;

        } catch (error) {

            // R7.51.29 — explicit exception metadata (Railway-visible).
            console.error(
                "[R7.51 TON DEPLOY ERROR]",
                {
                    name: error?.name ?? null,
                    message: error?.message ?? null,
                    stack: error?.stack ?? null,
                    cause: error?.cause ?? null
                }
            );

            this._logger?.error?.(
                "TON_DEPLOY_EXCEPTION_DETAILS",
                {
                    name: error?.name ?? null,
                    message: error?.message ?? null,
                    stack: error?.stack ?? null
                }
            );

            pushTonDeployDebugStage("FAILED", {
                errorName: error?.name ?? null,
                errorMessage: error?.message ?? String(error),
                tonCenterStatus: error?.status ?? null,
                tonCenterResponse: error?.responseBody ?? null,
                tonCenterEndpoint: error?.endpoint ?? null
            });

            this._logError(
                `TON GameContract deploy failed | ${error?.message ?? error}`
            );

            printDeployBlock("ADAPTER DEPLOY EXCEPTION (TonGameContractAdapter)", {
                "Error.name": error?.name ?? "unknown",
                "Error.message": error?.message ?? String(error),
                "Error.stack": error?.stack ?? null,
                "Serialized error": safeSerialize(error),
                ContractId: contractId,
                RoomId: snapshot?.roomId ?? null,
                Timestamp: new Date().toISOString()
            });

            const result = createDeployResultDTO({
                ok: false,
                reason: "deploy_failed"
            });

            printDeployBlock("ADAPTER deployContract RETURN", {
                Case: "B — ok:false (catch block)",
                ReturnedObject: safeSerialize(result),
                Timestamp: new Date().toISOString()
            });

            return result;

        }

    }

    async openContract(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const exists = await this.contractExists(address.friendly);

        return Object.freeze({
            address: address.friendly,
            network: this._service().getActiveNetwork(),
            exists
        });

    }

    /**
     * R7.66H — Send GameEscrow INIT_GAME (Tact ABI) to an already-deployed escrow.
     */
    async initGame({
        contractAddress,
        oracle,
        owner,
        contractIdHash,
        snapshotHash
    }) {

        if (!contractAddress || !oracle || !owner || !contractIdHash || !snapshotHash) {

            return createOperationResultDTO({
                ok: false,
                reason: "invalid_init_game_request"
            });

        }

        const mode = resolveGameEscrowMode(this._tonConfig?.gameEscrowMode);

        if (mode !== GAME_ESCROW_MODE_GAME) {

            return createOperationResultDTO({
                ok: false,
                reason: "init_game_requires_game_escrow_mode"
            });

        }

        try {

            const body = serializeGameEscrowInitGameBody({
                oracle,
                owner,
                contractIdHash,
                snapshotHash
            });

            if (this._canBroadcast()) {

                const txId = await this._sendOracleMessage({
                    to: contractAddress,
                    body,
                    valueTon: "0.05",
                    bounce: false,
                    resolveAccountTxHash: true
                });

                return createOperationResultDTO({
                    ok: true,
                    txId,
                    completedAt: Date.now()
                });

            }

            await this._service().broadcastTransaction(
                Buffer.from(
                    `init:${contractAddress}:${String(snapshotHash).slice(0, 16)}`
                ).toString("base64")
            );

            const txId = `ton_init_${String(snapshotHash).replace(/[^a-fA-F0-9]/g, "").slice(0, 16)}`;

            return createOperationResultDTO({
                ok: true,
                txId,
                completedAt: Date.now()
            });

        } catch (error) {

            this._logError(
                `TON GameEscrow INIT_GAME failed | ${error?.message ?? error}`
            );

            return createOperationResultDTO({
                ok: false,
                reason: "init_game_failed"
            });

        }

    }

    /**
     * R7.69A — Oracle OPEN_PAYMENTS: register player seats and open STAKE window.
     */
    async openPayments({
        contractAddress,
        players
    }) {

        if (!contractAddress || !Array.isArray(players) || players.length < 3) {

            return createOperationResultDTO({
                ok: false,
                reason: "invalid_open_payments_request"
            });

        }

        const mode = resolveGameEscrowMode(this._tonConfig?.gameEscrowMode);

        if (mode !== GAME_ESCROW_MODE_GAME) {

            return createOperationResultDTO({
                ok: false,
                reason: "open_payments_requires_game_escrow_mode"
            });

        }

        try {

            const body = serializeGameEscrowOpenPaymentsBody({
                player0: players[0].wallet,
                stake0: players[0].requiredGram,
                player1: players[1].wallet,
                stake1: players[1].requiredGram,
                player2: players[2].wallet,
                stake2: players[2].requiredGram
            });

            if (this._canBroadcast()) {

                const txId = await this._sendOracleMessage({
                    to: contractAddress,
                    body,
                    valueTon: "0.05",
                    bounce: false,
                    resolveAccountTxHash: true
                });

                return createOperationResultDTO({
                    ok: true,
                    txId,
                    completedAt: Date.now()
                });

            }

            await this._service().broadcastTransaction(
                Buffer.from(
                    `open:${contractAddress}:${players.map((p) => p.playerId).join(",")}`
                ).toString("base64")
            );

            return createOperationResultDTO({
                ok: true,
                txId: `ton_open_${String(contractAddress).slice(-12)}`,
                completedAt: Date.now()
            });

        } catch (error) {

            this._logError(
                `TON GameEscrow OPEN_PAYMENTS failed | ${error?.message ?? error}`
            );

            return createOperationResultDTO({
                ok: false,
                reason: "open_payments_failed"
            });

        }

    }

    async loadContract(contractAddress) {

        const opened = await this.openContract(contractAddress);

        if (!opened.exists) {

            throw new ContractNotFoundError(opened.address);

        }

        const state = await this.getContractState(opened.address);

        return Object.freeze({
            ...opened,
            state
        });

    }

    async contractExists(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const account = await this._service().getAccount(address.friendly);

        return account?.state === "active";

    }

    async getContractState(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.CONTRACT_STATE
        );

        return decodeContractState(
            address.friendly,
            this._service().getActiveNetwork(),
            stack
        );

    }

    async getPaidMask(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.PAID_MASK
        );

        return decodePaidMask(stack);

    }

    async getTotalPaid(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.TOTAL_PAID
        );

        return decodeTotalPaid(stack);

    }

    async getRequiredTotal(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.REQUIRED_TOTAL
        );

        return decodeRequiredTotal(stack);

    }

    async getPlayerPayment(contractAddress, playerIndex) {

        const address = this._parseAddress(contractAddress);

        const index = Number(playerIndex);

        if (!Number.isInteger(index) || index < 0) {

            throw new Error(`Invalid playerIndex for get_player_payment: ${playerIndex}`);

        }

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.PLAYER_PAYMENT,
            [{ type: "int", value: String(index) }]
        );

        return decodePlayerPayment(stack, index);

    }

    async getParticipants(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.PARTICIPANTS
        );

        return decodeParticipants(stack);

    }

    async getWinner(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.WINNER
        );

        return decodeWinner(address.friendly, stack);

    }

    async getSettlementState(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.SETTLEMENT_STATE
        );

        return decodeSettlementState(address.friendly, stack);

    }

    async getBalances(contractAddress) {

        const address = this._parseAddress(contractAddress);

        try {

            const stack = await this._runContractMethod(
                address.friendly,
                GAME_CONTRACT_GET_METHODS.BALANCES
            );

            return decodeBalances(address.friendly, stack);

        } catch {

            const account = await this._service().getAccount(address.friendly);

            return decodeBalances(address.friendly, {
                stack: [
                    { value: BigInt(account?.balance ?? "0") },
                    { value: 0n },
                    { value: null }
                ]
            });

        }

    }

    async getNetwork(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.NETWORK
        );

        return decodeNetwork(stack);

    }

    async getArchiveState(contractAddress) {

        const address = this._parseAddress(contractAddress);

        const stack = await this._runContractMethod(
            address.friendly,
            GAME_CONTRACT_GET_METHODS.ARCHIVE_STATE
        );

        return decodeArchiveState(address.friendly, stack);

    }

    async settle(settlementRequest) {

        if (!settlementRequest?.contractId
            || !settlementRequest?.contractAddress
            || !settlementRequest?.winnerWallet
            || !settlementRequest?.ownerWallet) {

            return createOperationResultDTO({
                ok: false,
                reason: "invalid_settlement_request"
            });

        }

        const gameEscrowMode = resolveGameEscrowMode(
            settlementRequest.gameEscrowMode ?? this._tonConfig?.gameEscrowMode
        );

        try {

            if (this._canBroadcast()) {

                const broadcast = await this._broadcastSettle(settlementRequest);

                if (!broadcast.ok) {

                    return createOperationResultDTO({
                        ok: false,
                        reason: broadcast.reason ?? "settle_failed"
                    });

                }

                return createOperationResultDTO({
                    ok: true,
                    txId: broadcast.settlementTxId,
                    completedAt: broadcast.settledAt ?? Date.now()
                });

            }

            // Stub / no-mnemonic path — still emit GameEscrow settlement diagnostics.
            const settlePlan = this._buildSettleMessagePlan(settlementRequest);

            if (!settlePlan.ok) {

                return createOperationResultDTO({
                    ok: false,
                    reason: settlePlan.reason
                });

            }

            this._recordGameEscrowSettlementDebug({
                mode: gameEscrowMode,
                settlementRequest,
                snapshotHash: settlePlan.snapshotHash,
                transactionHash: null
            });

            await this._service().broadcastTransaction(
                serializeSettleBocPlaceholder({
                    contractId: settlementRequest.contractId,
                    winnerId: settlementRequest.winnerId
                })
            );

            const settlementTxId = `ton_settle_${String(settlementRequest.contractId)
                .replace(/[^a-zA-Z0-9]/g, "")
                .slice(-16)}`;

            this._recordGameEscrowSettlementDebug({
                mode: gameEscrowMode,
                settlementRequest,
                snapshotHash: settlePlan.snapshotHash,
                transactionHash: settlementTxId
            });

            this._logInfo(
                `TON GameContract settled | contractId=${settlementRequest.contractId} | `
                    + `mode=${gameEscrowMode}`
            );

            return createOperationResultDTO({
                ok: true,
                txId: settlementTxId,
                completedAt: Date.now()
            });

        } catch (error) {

            this._logError(
                `TON GameContract settle failed | ${error?.message ?? error}`
            );

            return createOperationResultDTO({
                ok: false,
                reason: "settle_failed"
            });

        }

    }

    async archive({ contractAddress }) {

        if (!contractAddress) {

            return createOperationResultDTO({
                ok: false,
                reason: "invalid_archive_request"
            });

        }

        try {

            const address = this._parseAddress(contractAddress);

            const txId = await this._sendOracleMessage({
                to: address.friendly,
                body: serializeArchiveBody(),
                valueTon: "0.05"
            });

            return createOperationResultDTO({
                ok: true,
                txId,
                completedAt: Date.now()
            });

        } catch (error) {

            this._logError(
                `TON GameContract archive failed | ${error?.message ?? error}`
            );

            return createOperationResultDTO({
                ok: false,
                reason: "archive_failed"
            });

        }

    }

    async cancel({ contractAddress, reasonCode = 0 }) {

        if (!contractAddress) {

            return createOperationResultDTO({
                ok: false,
                reason: "invalid_cancel_request"
            });

        }

        try {

            const address = this._parseAddress(contractAddress);

            const txId = await this._sendOracleMessage({
                to: address.friendly,
                body: serializeEmergencyCancelBody({ reasonCode }),
                valueTon: "0.05"
            });

            return createOperationResultDTO({
                ok: true,
                txId,
                completedAt: Date.now()
            });

        } catch (error) {

            this._logError(
                `TON GameContract cancel failed | ${error?.message ?? error}`
            );

            return createOperationResultDTO({
                ok: false,
                reason: "cancel_failed"
            });

        }

    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    _service() {

        if (this._tonService) {

            return this._tonService;

        }

        if (!this._legacyShim) {

            this._legacyShim = createLegacyTonServiceShim({
                transport: this._legacyTransport,
                tonClient: this._legacyTonClient,
                tonConfig: this._tonConfig
            });

        }

        return this._legacyShim;

    }

    _parseAddress(contractAddress) {

        const parsed = parseContractAddress(contractAddress, {
            network: this._service().getActiveNetwork()
        });

        assertNetworkCompatibility(parsed, this._service().getActiveNetwork());

        return parsed;

    }

    async _runContractMethod(address, method, stack = []) {

        if (!await this.contractExists(address)) {

            throw new ContractNotFoundError(address);

        }

        return this._service().runGetMethod(address, method, stack);

    }

    _canBroadcast() {

        return Boolean(this._tonConfig?.deployerMnemonic);

    }

    /**
     * Poll until escrow account is active on-chain (live broadcast path only).
     * Transient RPC errors are retried until timeout.
     */
    async _waitUntilEscrowActive(contractAddress) {

        const expected = String(contractAddress ?? "").trim();

        if (!expected) {

            return {
                ok: false,
                reason: "escrow_activation_missing_address"
            };

        }

        const pollIntervalMs = Number(this._tonConfig?.pollIntervalMs);

        const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 200
            ? pollIntervalMs
            : 2000;

        const configuredTimeout = Number(
            this._tonConfig?.escrowActivationTimeoutMs
        );

        const timeoutMs = Number.isFinite(configuredTimeout)
            && configuredTimeout >= 200
            ? configuredTimeout
            : DEFAULT_ESCROW_ACTIVATION_TIMEOUT_MS;

        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {

            try {

                const active = await this.contractExists(expected);

                if (active === true) {

                    this._logInfo(
                        `TON escrow active | address=${expected}`
                    );

                    return { ok: true };

                }

            } catch (error) {

                this._logError(
                    `TON escrow activation poll error | address=${expected} | `
                        + `${error?.message ?? error}`
                );

            }

            const remaining = deadline - Date.now();

            if (remaining <= 0) {

                break;

            }

            await sleep(Math.min(interval, remaining));

        }

        this._logError(
            `TON escrow activation timeout | address=${expected} | `
                + `timeoutMs=${timeoutMs}`
        );

        return {
            ok: false,
            reason: "escrow_activation_timeout"
        };

    }

    async _broadcastDeploy(escrow) {

        const txId = await this._sendOracleMessage({
            to: escrow.address,
            init: escrow.stateInit,
            body: beginCell().endCell(),
            valueTon: "0.05",
            bounce: false
        });

        return {
            ok: true,
            deploymentTxId: txId,
            deployedAt: Date.now()
        };

    }

    async _broadcastSettle(settlementRequest) {

        const settlePlan = this._buildSettleMessagePlan(settlementRequest);

        if (!settlePlan.ok) {

            return {
                ok: false,
                reason: settlePlan.reason
            };

        }

        this._recordGameEscrowSettlementDebug({
            mode: settlePlan.mode,
            settlementRequest,
            snapshotHash: settlePlan.snapshotHash,
            transactionHash: null
        });

        const txId = await this._sendOracleMessage({
            to: settlementRequest.contractAddress,
            body: settlePlan.body,
            valueTon: "0.05",
            bounce: settlePlan.mode === GAME_ESCROW_MODE_GAME ? false : true,
            // R7.61A — resolve real deployer account tx hash (not ton_oracle_seq_*).
            resolveAccountTxHash: true
        });

        this._recordGameEscrowSettlementDebug({
            mode: settlePlan.mode,
            settlementRequest,
            snapshotHash: settlePlan.snapshotHash,
            transactionHash: txId
        });

        return {
            ok: true,
            settlementTxId: txId,
            settledAt: Date.now()
        };

    }

    /**
     * R7.66F — Build settle body for v4 (legacy) or game (GameEscrow ABI).
     */
    _buildSettleMessagePlan(settlementRequest) {

        return buildSettleMessagePlan(settlementRequest, this._tonConfig);

    }

    _recordGameEscrowSettlementDebug({
        mode,
        settlementRequest,
        snapshotHash,
        transactionHash
    }) {

        const debug = {
            mode,
            escrowAddress: settlementRequest?.contractAddress ?? null,
            winner: settlementRequest?.winnerWallet ?? null,
            owner: settlementRequest?.ownerWallet ?? null,
            winnerAmount: settlementRequest?.winnerAmount ?? null,
            ownerAmount: settlementRequest?.organizerAmount
                ?? settlementRequest?.ownerAmount
                ?? null,
            snapshotHash: snapshotHash ?? null,
            transactionHash: transactionHash ?? null
        };

        setGameEscrowSettlementDebug(debug);
        printGameEscrowSettlementDebug(debug);

    }

    async _sendOracleMessage({
        to,
        body,
        init = null,
        valueTon = "0.05",
        bounce = true,
        resolveAccountTxHash = false
    }) {

        try {

            console.log("[R7.51 TON DEPLOY]\nstage=WALLET_CREATE_START");
            pushTonDeployDebugStage("WALLET_CREATE_START", { valueTon });

            const keyPair = await mnemonicToPrivateKey(
                this._tonConfig.deployerMnemonic.split(/\s+/).filter(Boolean)
            );

            const deployerWallet = WalletContractV4.create({
                workchain: 0,
                publicKey: keyPair.publicKey
            });

            const deployerAddress = deployerWallet.address.toString({
                bounceable: true,
                urlSafe: true
            });

            const deployerWalletId = deployerWallet.walletId ?? null;

            console.log(
                "[R7.51 TON DEPLOY]\n"
                    + `stage=WALLET_CREATED\n`
                    + `address=${deployerAddress}\n`
                    + `walletId=${deployerWalletId}`
            );
            pushTonDeployDebugStage("WALLET_CREATED", {
                deployerAddress,
                deployerWalletId
            });

            const seqno = await this._service().getSeqno(deployerAddress);

            console.log(
                "[R7.51 TON DEPLOY]\n"
                    + `stage=SEQNO_READ\n`
                    + `seqno=${seqno}`
            );
            pushTonDeployDebugStage("SEQNO_READ", { seqno });

            const destination = typeof to === "string"
                ? to
                : to.toString({ bounceable: true, urlSafe: true });

            console.log("[R7.51 TON DEPLOY]\nstage=TRANSFER_CREATE_START");
            pushTonDeployDebugStage("TRANSFER_CREATE_START");

            const transfer = deployerWallet.createTransfer({
                seqno,
                secretKey: keyPair.secretKey,
                messages: [
                    internal({
                        to: destination,
                        value: toNano(valueTon),
                        init: init ?? undefined,
                        body,
                        bounce
                    })
                ]
            });

            console.log("[R7.51 TON DEPLOY]\nstage=TRANSFER_CREATED");
            pushTonDeployDebugStage("TRANSFER_CREATED");

            // R7.54 — TonCenter sendBoc requires a full external-in Message BOC,
            // not the raw signed transfer body Cell from createTransfer().
            const externalMessage = external({
                to: deployerWallet.address,
                body: transfer
            });

            const bocBase64 = beginCell()
                .store(storeMessage(externalMessage))
                .endCell()
                .toBoc()
                .toString("base64");

            console.log("[R7.51 TON DEPLOY]\nstage=BOC_CREATED");
            pushTonDeployDebugStage("BOC_CREATED");

            console.log("[R7.51 TON DEPLOY]\nstage=BOC_SEND_START");
            pushTonDeployDebugStage("BOC_SEND_START");

            const sentAtMs = Date.now();

            await this._service().broadcastTransaction(bocBase64);

            console.log("[R7.51 TON DEPLOY]\nstage=BOC_SEND_SUCCESS");
            pushTonDeployDebugStage("BROADCAST_SENT");
            pushTonDeployDebugStage("BOC_SEND_SUCCESS");

            if (!resolveAccountTxHash) {

                return `ton_oracle_seq_${seqno}`;

            }

            return this._lookupDeployerAccountTxHash({
                deployerAddress,
                destinationAddress: destination,
                seqno,
                sentAtMs
            });

        } catch (error) {

            console.log(
                "[R7.51 TON DEPLOY]\n"
                    + "stage=FAILED\n"
                    + `errorName=${error?.name ?? null}\n`
                    + `errorMessage=${error?.message ?? String(error)}`
            );
            pushTonDeployDebugStage("FAILED", {
                errorName: error?.name ?? null,
                errorMessage: error?.message ?? String(error),
                tonCenterStatus: error?.status ?? null,
                tonCenterResponse: error?.responseBody ?? null,
                tonCenterEndpoint: error?.endpoint ?? null
            });

            throw error;

        }

    }

    /**
     * R7.61A — After settlement sendBoc, resolve deployer account transaction_id.hash.
     *
     * Algorithm:
     *   1. Poll getTransactions(deployer) until timeout.
     *   2. Match a tx whose out_msg.destination equals the escrow/settle destination.
     *   3. Prefer txs with utime >= sentAt (minus small skew).
     *   4. Return transaction_id.hash of the newest matching tx.
     *
     * Timeout: tonConfig.settlementTxLookupTimeoutMs (default 30000).
     * Poll: tonConfig.settlementTxLookupPollMs (default 1000).
     */
    async _lookupDeployerAccountTxHash({
        deployerAddress,
        destinationAddress,
        seqno,
        sentAtMs
    }) {

        const timeoutMs = Number.isFinite(this._tonConfig?.settlementTxLookupTimeoutMs)
            ? this._tonConfig.settlementTxLookupTimeoutMs
            : 30_000;

        const pollMs = Number.isFinite(this._tonConfig?.settlementTxLookupPollMs)
            ? Math.max(50, this._tonConfig.settlementTxLookupPollMs)
            : 1_000;

        const destination = Address.parse(destinationAddress);
        const sentAtSec = Math.floor(sentAtMs / 1000);
        const deadline = Date.now() + timeoutMs;
        let pollCount = 0;

        console.log(
            "[R7.61 SETTLEMENT TX]\n"
                + "stage=SETTLEMENT_TX_LOOKUP_START\n"
                + `deployer=${deployerAddress}\n`
                + `destination=${destinationAddress}\n`
                + `seqno=${seqno}\n`
                + `timeoutMs=${timeoutMs}`
        );

        while (Date.now() < deadline) {

            pollCount += 1;

            console.log(
                "[R7.61 SETTLEMENT TX]\n"
                    + "stage=SETTLEMENT_TX_LOOKUP_POLL\n"
                    + `poll=${pollCount}`
            );

            const transactions = await this._service().getTransactions(
                deployerAddress,
                { limit: 20 }
            );

            const match = this._findSettlementDeployerTx(
                transactions,
                destination,
                sentAtSec
            );

            if (match?.hash) {

                console.log(
                    "[R7.61 SETTLEMENT TX]\n"
                        + "stage=SETTLEMENT_TX_LOOKUP_MATCHED\n"
                        + `hash=${match.hash}\n`
                        + `poll=${pollCount}`
                );

                return match.hash;

            }

            await delay(pollMs);

        }

        console.log(
            "[R7.61 SETTLEMENT TX]\n"
                + "stage=SETTLEMENT_TX_LOOKUP_TIMEOUT\n"
                + `polls=${pollCount}\n`
                + `seqno=${seqno}`
        );

        throw new Error(
            `settlement_tx_lookup_timeout | seqno=${seqno} | `
                + `deployer=${deployerAddress}`
        );

    }

    _findSettlementDeployerTx(transactions, destinationAddress, sentAtSec) {

        if (!Array.isArray(transactions) || transactions.length === 0) {

            return null;

        }

        const skewSec = 30;
        const minUtime = Number.isFinite(sentAtSec) ? sentAtSec - skewSec : null;

        for (const tx of transactions) {

            const utime = Number(tx?.utime ?? tx?.now ?? NaN);

            if (minUtime != null && Number.isFinite(utime) && utime < minUtime) {

                continue;

            }

            const outMsgs = tx?.out_msgs ?? tx?.outMessages ?? [];

            if (!Array.isArray(outMsgs) || outMsgs.length === 0) {

                continue;

            }

            const targetsEscrow = outMsgs.some((msg) => {

                const raw = msg?.destination
                    ?? msg?.dest
                    ?? msg?.info?.dest
                    ?? null;

                return addressesEqual(raw, destinationAddress);

            });

            if (!targetsEscrow) {

                continue;

            }

            const hash = tx?.transaction_id?.hash
                ?? tx?.txHash
                ?? tx?.hash
                ?? null;

            if (!hash) {

                continue;

            }

            return { hash: String(hash), tx };

        }

        return null;

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

    _logError(message) {

        this._logger?.error?.(message);

    }

}

function delay(ms) {

    return new Promise((resolve) => {

        setTimeout(resolve, ms);

    });

}

function addressesEqual(raw, expectedAddress) {

    if (!raw || !expectedAddress) {

        return false;

    }

    try {

        const left = typeof raw === "string"
            ? Address.parse(raw)
            : raw;

        if (expectedAddress instanceof Address) {

            return left.equals(expectedAddress);

        }

        return left.equals(Address.parse(String(expectedAddress)));

    } catch {

        const left = canonicalizeTonWalletAddress(String(raw));
        const right = canonicalizeTonWalletAddress(String(expectedAddress));

        return Boolean(left && right && left === right);

    }

}

export {
    ContractAlreadyExistsError,
    ContractNotFoundError,
    ContractStateError,
    DeserializationError,
    GameContractAdapterError,
    InvalidAddressError,
    InvalidContractResponseError,
    SerializationError,
    UnsupportedContractVersionError
} from "./ton/gameContract/GameContractErrors.js";

export {
    createArchiveDTO,
    createBalanceDTO,
    createContractStateDTO,
    createDeployResultDTO,
    createOperationResultDTO,
    createParticipantDTO,
    createSettlementDTO,
    createWinnerDTO
} from "./ton/gameContract/GameContractDtos.js";

export {
    GAME_CONTRACT_GET_METHODS,
    GAME_CONTRACT_ON_CHAIN_STATUS,
    GAME_CONTRACT_OPCODES,
    GAME_CONTRACT_VERSION
} from "./ton/gameContract/GameContractOpcodes.js";
