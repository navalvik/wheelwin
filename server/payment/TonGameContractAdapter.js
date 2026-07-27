/**
 * T2.3 — Production TON Game Smart Contract adapter.
 *
 * Owns contract ABI encoding/decoding. Communicates only with TonService.
 * Gameplay modules never import @ton/* except through this adapter boundary.
 */

import { beginCell, internal, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { buildGameEscrowWallet } from "./ton/buildGameEscrowStateInit.js";
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
    decodeSettlementState,
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
    serializeLegacySettleBody,
    serializeSettleBocPlaceholder
} from "./ton/gameContract/GameContractSerializer.js";
import { createLegacyTonServiceShim } from "./ton/gameContract/legacyTonServiceShim.js";

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

        const result = await this.deployContract({ contractId, snapshot });

        return {
            ok: result.ok,
            contractAddress: result.contractAddress,
            deploymentTxId: result.deploymentTxId,
            deployedAt: result.deployedAt,
            snapshotHash: result.snapshotHash,
            reason: result.reason
        };

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

        if (!contractId || !snapshot) {

            return createDeployResultDTO({
                ok: false,
                reason: "invalid_deploy_request"
            });

        }

        try {

            const escrow = buildGameEscrowWallet({ contractId, snapshot });

            const contractAddress = escrow.addressFriendly;

            let deploymentTxId = null;

            let deployedAt = Date.now();

            if (this._canBroadcast()) {

                const broadcast = await this._broadcastDeploy(escrow);

                if (!broadcast.ok) {

                    return createDeployResultDTO({
                        ok: false,
                        reason: broadcast.reason ?? "deploy_failed"
                    });

                }

                deploymentTxId = broadcast.deploymentTxId;

                deployedAt = broadcast.deployedAt ?? deployedAt;

            } else {

                await this._service().broadcastTransaction(
                    serializeDeployBocPlaceholder({ contractId })
                );

                deploymentTxId = `ton_addr_${escrow.snapshotHash.slice(0, 16)}`;

            }

            this._logInfo(
                `TON GameContract deployed | contractId=${contractId} | `
                    + `address=${contractAddress}`
            );

            return createDeployResultDTO({
                ok: true,
                contractAddress,
                deploymentTxId,
                deployedAt,
                snapshotHash: escrow.snapshotHash
            });

        } catch (error) {

            this._logError(
                `TON GameContract deploy failed | ${error?.message ?? error}`
            );

            return createDeployResultDTO({
                ok: false,
                reason: "deploy_failed"
            });

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

            await this._service().broadcastTransaction(
                serializeSettleBocPlaceholder({
                    contractId: settlementRequest.contractId,
                    winnerId: settlementRequest.winnerId
                })
            );

            const settlementTxId = `ton_settle_${String(settlementRequest.contractId)
                .replace(/[^a-zA-Z0-9]/g, "")
                .slice(-16)}`;

            this._logInfo(
                `TON GameContract settled | contractId=${settlementRequest.contractId}`
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

    async _runContractMethod(address, method) {

        if (!await this.contractExists(address)) {

            throw new ContractNotFoundError(address);

        }

        return this._service().runGetMethod(address, method, []);

    }

    _canBroadcast() {

        return Boolean(this._tonConfig?.deployerMnemonic);

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

        const txId = await this._sendOracleMessage({
            to: settlementRequest.contractAddress,
            body: serializeLegacySettleBody({
                winnerAmount: settlementRequest.winnerAmount,
                organizerAmount: settlementRequest.organizerAmount
            }),
            valueTon: "0.05",
            bounce: true
        });

        return {
            ok: true,
            settlementTxId: txId,
            settledAt: Date.now()
        };

    }

    async _sendOracleMessage({
        to,
        body,
        init = null,
        valueTon = "0.05",
        bounce = true
    }) {

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

        const seqno = await this._service().getSeqno(deployerAddress);

        const destination = typeof to === "string"
            ? to
            : to.toString({ bounceable: true, urlSafe: true });

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

        await this._service().broadcastTransaction(
            transfer.toBoc().toString("base64")
        );

        return `ton_oracle_seq_${seqno}`;

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

    _logError(message) {

        this._logger?.error?.(message);

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
