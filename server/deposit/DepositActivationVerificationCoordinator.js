/**
 * R17.9L.22 — Deposit activation verification security gate.
 *
 * Read-only vs chain. Authorizes DepositMonitor watching only after
 * independent ACTIVE + artifact + getter + initial-state proof.
 *
 * Does not deploy, send TON, fund seats, emit DEPOSIT_FULL,
 * or create DeploymentAuthorization.
 */

import { Address } from "@ton/core";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import {
    buildDepositStateInit,
    DEPOSIT_CONTRACT_VERSION,
    loadDepositCodeCell
} from "../payment/ton/buildDepositStateInit.js";
import {
    hashDepositId,
    hashGameId,
    hashRoomId,
    bufferToUint256
} from "../payment/ton/depositContractHashes.js";
import { assertInitialMutableState } from "../payment/ton/readDepositGetters.js";
import { assertVerifiedDepositArtifact } from "../payment/ton/verifyDepositArtifact.js";
import {
    InvalidResponseError,
    NetworkUnavailableError,
    TimeoutError
} from "../services/ton/TonServiceErrors.js";
import { isInfrastructureFailure } from "../services/ton/TonServiceRetry.js";
import {
    DEPOSIT_ACCOUNT_STATE,
    DEPOSIT_NETWORK_TAG,
    DEPOSIT_ONCHAIN_STATUS
} from "./RealTonDepositBlockchainSource.js";
import {
    DEPOSIT_ACTIVATION_ERROR_CODES,
    DEPOSIT_ACTIVATION_STATUS,
    DepositActivationVerificationError
} from "./DepositActivationVerificationErrors.js";
import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";

function sameCanonicalAddress(left, right) {

    const a = canonicalizeTonWalletAddress(
        left instanceof Address
            ? left.toString({ bounceable: true, urlSafe: true })
            : left
    );

    const b = canonicalizeTonWalletAddress(
        right instanceof Address
            ? right.toString({ bounceable: true, urlSafe: true })
            : right
    );

    return Boolean(a) && a === b;

}

function toBigInt(value) {

    if (typeof value === "bigint") {

        return value;

    }

    if (typeof value === "number" && Number.isInteger(value)) {

        return BigInt(value);

    }

    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {

        return BigInt(value.trim());

    }

    if (Buffer.isBuffer(value)) {

        return bufferToUint256(value);

    }

    return BigInt(value);

}

function isRpcFailure(error) {

    return isInfrastructureFailure(error)
        || error instanceof NetworkUnavailableError
        || error instanceof TimeoutError;
}

export class DepositActivationVerificationCoordinator {

    constructor({
        logger = null,
        eventBus = null,
        depositSessionCoordinator = null,
        depositMonitor = null,
        blockchainSource = null,
        tonService = null,
        network = "testnet",
        expectedArtifactSha256 = null,
        env = process.env,
        gameContractManager = null,
        deploymentAuthorizationCoordinator = null,
        roomManager = null
    } = {}) {

        this._logger = logger ?? { info() {}, warn() {}, error() {}, debug() {} };

        this._eventBus = eventBus;

        this._depositSessionCoordinator = depositSessionCoordinator;

        this._depositMonitor = depositMonitor;

        this._blockchainSource = blockchainSource;

        this._tonService = tonService;

        this._network = String(network ?? "testnet").trim().toLowerCase();

        this._expectedArtifactSha256 = expectedArtifactSha256;

        this._env = env;

        this._gameContractManager = gameContractManager;

        this._deploymentAuthorizationCoordinator = deploymentAuthorizationCoordinator;

        this._roomManager = roomManager;

        this._processing = new Set();

        this._verified = new Set();

    }

    isVerified(depositId) {

        return this._verified.has(depositId);

    }

    /**
     * Restart entry: persisted VERIFIED is not sufficient.
     * Re-query the chain before authorizing a watch.
     */
    async syncFromActiveSessions() {

        const sessions = this._depositSessionCoordinator?.listActiveDepositSessions?.() ?? [];

        const summary = {
            scanned: 0,
            verified: 0,
            waiting: 0,
            rejected: 0,
            skipped: 0
        };

        for (const session of sessions) {

            summary.scanned += 1;

            if (!session?.depositId || !session.depositAddress) {

                summary.skipped += 1;

                continue;

            }

            if (!this._isAssociatedRoomLive(session.roomId)) {

                summary.skipped += 1;

                continue;

            }

            if (
                session.state !== DEPOSIT_SESSION_STATUS.AWAITING_FUNDS
                && session.state !== DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED
                && session.state !== DEPOSIT_SESSION_STATUS.PLAYER_BINDING
            ) {

                summary.skipped += 1;

                continue;

            }

            try {

                const result = await this.verifyActivation(session.depositId);

                if (result.status === DEPOSIT_ACTIVATION_STATUS.VERIFIED
                    || result.status === DEPOSIT_ACTIVATION_STATUS.ALREADY_VERIFIED) {

                    summary.verified += 1;

                } else if (result.status === DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT) {

                    summary.waiting += 1;

                } else {

                    summary.rejected += 1;

                }

            } catch {

                summary.rejected += 1;

            }

        }

        return Object.freeze(summary);

    }

    _isAssociatedRoomLive(roomId) {

        if (typeof this._roomManager?.getRoom !== "function") {

            return true;

        }

        if (!roomId) {

            return true;

        }

        return Boolean(this._roomManager.getRoom(roomId));

    }

    /**
     * @param {string} depositId
     * @param {object} [untrustedInput] Client/socket fields are ignored.
     */
    async verifyActivation(depositId, untrustedInput = null) {

        void untrustedInput;

        if (!depositId) {

            throw new DepositActivationVerificationError(
                "depositId is required",
                DEPOSIT_ACTIVATION_ERROR_CODES.SESSION_NOT_FOUND,
                { depositId }
            );

        }

        if (this._processing.has(depositId)) {

            return Object.freeze({
                status: DEPOSIT_ACTIVATION_STATUS.ALREADY_VERIFIED,
                depositId,
                watchStarted: this._hasWatch(depositId)
            });

        }

        this._processing.add(depositId);

        try {

            return await this._verifyActivation(depositId);

        } finally {

            this._processing.delete(depositId);

        }

    }

    async _verifyActivation(depositId) {

        this._assertNoFinancialSideEffects();

        const session = this._depositSessionCoordinator?.getSession?.(depositId) ?? null;

        if (!session) {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.SESSION_NOT_FOUND,
                "DepositSession not found",
                { depositId }
            );

        }

        const persistedAddress = session.depositAddress;

        if (!persistedAddress) {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.DEPOSIT_ADDRESS_MISSING,
                "DepositSession has no depositAddress",
                { depositId }
            );

        }

        const plan = this._deriveExpectedPlan(session);

        if (!sameCanonicalAddress(plan.addressFriendly ?? plan.address, persistedAddress)) {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.ADDRESS_MISMATCH,
                "Derived Deposit address does not match persisted depositAddress",
                {
                    depositId,
                    persistedAddress,
                    derivedAddress: plan.addressFriendly
                }
            );

        }

        const contractState = await this._queryContractState(persistedAddress, depositId);

        if (contractState.state === DEPOSIT_ACCOUNT_STATE.UNINIT) {

            return this._waiting(session, contractState);

        }

        if (contractState.state !== DEPOSIT_ACCOUNT_STATE.ACTIVE) {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.ACCOUNT_NOT_ACTIVE,
                "Deposit account is not ACTIVE",
                { depositId, state: contractState.state }
            );

        }

        if (!contractState.codeHash) {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.CODE_MISSING,
                "Deposit account has no code",
                { depositId }
            );

        }

        const expectedCodeHash = this._expectedCodeHash();

        if (contractState.codeHash !== expectedCodeHash) {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.CODE_HASH_MISMATCH,
                "On-chain code hash does not match verified Deposit artifact",
                {
                    depositId,
                    expectedCodeHash,
                    actualCodeHash: contractState.codeHash
                }
            );

        }

        const getters = await this._readGetters(persistedAddress, depositId);

        this._assertNetworkTag(session, getters, plan);

        this._assertReleaseAuthority(session, getters, plan);

        this._assertPlayers(session, getters, plan);

        this._assertFinancialParameters(session, getters, plan);

        this._assertContractVersion(getters, plan);

        this._assertIdentityHashes(session, getters, plan);

        this._assertExpiresAt(getters, plan);

        try {

            assertInitialMutableState(getters);

        } catch (error) {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.INITIAL_STATE_INVALID,
                error?.message ?? "Initial mutable state is invalid",
                { depositId, status: getters.status }
            );

        }

        const alreadyWatching = this._hasWatch(depositId);

        const verification = {
            status: DEPOSIT_ACTIVATION_STATUS.VERIFIED,
            depositId,
            depositAddress: persistedAddress,
            codeHash: contractState.codeHash,
            verifiedAt: Date.now(),
            network: this._network
        };

        this._persistVerification(depositId, verification);

        this._verified.add(depositId);

        this._emit(EVENT_TYPES.DEPOSIT_ACTIVATION_VERIFIED, session, verification);

        this._startWatchIfNeeded(session);

        return Object.freeze({
            status: alreadyWatching
                ? DEPOSIT_ACTIVATION_STATUS.ALREADY_VERIFIED
                : DEPOSIT_ACTIVATION_STATUS.VERIFIED,
            depositId,
            depositAddress: persistedAddress,
            watchStarted: this._hasWatch(depositId)
        });

    }

    _deriveExpectedPlan(session) {

        const metadata = session.metadata && typeof session.metadata === "object"
            ? session.metadata
            : {};

        const fee = metadata.creationFeePerSeat;

        if (fee == null) {

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                "Authoritative creationFeePerSeat is missing",
                { depositId: session.depositId }
            );

        }

        const expiresAt = metadata.contractExpiresAt
            ?? metadata.expiresAtUnix
            ?? null;

        if (expiresAt == null) {

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                "Authoritative contractExpiresAt is missing",
                { depositId: session.depositId }
            );

        }

        const network = String(metadata.network ?? metadata.tonNetwork ?? this._network)
            .trim()
            .toLowerCase();

        const players = (session.bindings ?? []).map((binding, index) => {

            const stake = binding.expectedStake
                ?? metadata[`expectedStake${index}`]
                ?? binding.expectedAmount;

            return {
                playerId: binding.playerId,
                wallet: binding.wallet,
                expectedStake: stake
            };

        });

        try {

            return buildDepositStateInit({
                depositId: session.depositId,
                roomId: session.roomId,
                gameId: session.gameId,
                players,
                creationFeePerSeat: fee,
                expiresAt,
                network,
                releaseAuthority: metadata.releaseAuthority ?? null,
                contractVersion: metadata.contractVersion ?? DEPOSIT_CONTRACT_VERSION,
                expectedArtifactSha256: this._expectedArtifactSha256,
                env: this._env
            });

        } catch (error) {

            if (error instanceof DepositActivationVerificationError) {

                throw error;

            }

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                error?.message ?? "Unable to derive expected Deposit StateInit",
                { depositId: session.depositId }
            );

        }

    }

    async _queryContractState(address, depositId) {

        if (typeof this._blockchainSource?.getContractState !== "function") {

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.RPC_FAILURE,
                "Blockchain source is not configured",
                { depositId }
            );

        }

        try {

            return await this._blockchainSource.getContractState(address);

        } catch (error) {

            if (isRpcFailure(error)) {

                throw this._reject(
                    depositId,
                    DEPOSIT_ACTIVATION_ERROR_CODES.RPC_FAILURE,
                    error?.message ?? "TON RPC failure",
                    { depositId }
                );

            }

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.ACCOUNT_NOT_ACTIVE,
                error?.message ?? "Unable to read contract state",
                { depositId }
            );

        }

    }

    async _readGetters(address, depositId) {

        try {

            if (typeof this._blockchainSource?.readActivationGetters === "function") {

                return await this._blockchainSource.readActivationGetters(address);

            }

            const { readFullDepositGetters } = await import(
                "../payment/ton/readDepositGetters.js"
            );

            if (!this._tonService) {

                throw new InvalidResponseError("TonService is not configured");

            }

            return await readFullDepositGetters(this._tonService, address);

        } catch (error) {

            if (error instanceof DepositActivationVerificationError) {

                throw error;

            }

            if (isRpcFailure(error)) {

                throw this._reject(
                    depositId,
                    DEPOSIT_ACTIVATION_ERROR_CODES.RPC_FAILURE,
                    error?.message ?? "TON RPC failure during getter read",
                    { depositId }
                );

            }

            throw this._reject(
                depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.GETTER_READ_FAILED,
                error?.message ?? "Deposit getter read failed",
                { depositId }
            );

        }

    }

    _expectedCodeHash() {

        assertVerifiedDepositArtifact({
            expectedSha256: this._expectedArtifactSha256 ?? null
        });

        const code = loadDepositCodeCell({
            expectedSha256: this._expectedArtifactSha256 ?? null
        });

        return code.hash().toString("hex");

    }

    _assertNetworkTag(session, getters, plan) {

        const expected = Number(
            plan.networkTag ?? DEPOSIT_NETWORK_TAG[this._network] ?? 0
        );

        if (Number(getters.networkTag) !== expected) {

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.NETWORK_MISMATCH,
                "On-chain networkTag does not match authoritative network",
                {
                    depositId: session.depositId,
                    expected,
                    actual: Number(getters.networkTag)
                }
            );

        }

    }

    _assertReleaseAuthority(session, getters, plan) {

        if (!sameCanonicalAddress(getters.releaseAuthority, plan.releaseAuthority)) {

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.RELEASE_AUTHORITY_MISMATCH,
                "On-chain releaseAuthority does not match authoritative oracle",
                { depositId: session.depositId }
            );

        }

    }

    _assertPlayers(session, getters, plan) {

        const expected = [
            plan.bindings[0].wallet,
            plan.bindings[1].wallet,
            plan.bindings[2].wallet
        ];

        const actual = [getters.player0, getters.player1, getters.player2];

        for (let index = 0; index < 3; index += 1) {

            if (!sameCanonicalAddress(actual[index], expected[index])) {

                throw this._reject(
                    session.depositId,
                    DEPOSIT_ACTIVATION_ERROR_CODES.PLAYER_BINDING_MISMATCH,
                    `On-chain player${index} does not match DepositSession binding`,
                    { depositId: session.depositId, seatIndex: index }
                );

            }

        }

    }

    _assertFinancialParameters(session, getters, plan) {

        const fee = toBigInt(plan.creationFeePerSeat);
        const stake0 = toBigInt(plan.bindings[0].expectedAmount);
        const stake1 = toBigInt(plan.bindings[1].expectedAmount);
        const stake2 = toBigInt(plan.bindings[2].expectedAmount);

        const expected = {
            expectedStake0: stake0,
            expectedStake1: stake1,
            expectedStake2: stake2,
            creationFeePerSeat: fee,
            expectedAmount0: stake0 + fee,
            expectedAmount1: stake1 + fee,
            expectedAmount2: stake2 + fee
        };

        for (const [field, value] of Object.entries(expected)) {

            if (toBigInt(getters[field]) !== value) {

                throw this._reject(
                    session.depositId,
                    DEPOSIT_ACTIVATION_ERROR_CODES.FINANCIAL_PARAMETER_MISMATCH,
                    `On-chain ${field} does not match authoritative configuration`,
                    { depositId: session.depositId, field }
                );

            }

        }

    }

    _assertContractVersion(getters, plan) {

        if (toBigInt(getters.contractVersion) !== toBigInt(plan.contractVersion)) {

            throw this._reject(
                plan.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                "On-chain contractVersion does not match",
                { depositId: plan.depositId }
            );

        }

    }

    _assertIdentityHashes(session, getters, plan) {

        const expectedDeposit = bufferToUint256(hashDepositId(session.depositId));
        const expectedRoom = bufferToUint256(hashRoomId(session.roomId));
        const expectedGame = bufferToUint256(hashGameId(session.gameId));

        if (toBigInt(getters.depositIdHash) !== expectedDeposit) {

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                "On-chain depositId hash does not match authoritative depositId",
                { depositId: session.depositId }
            );

        }

        if (toBigInt(getters.roomIdHash) !== expectedRoom) {

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                "On-chain roomId hash does not match authoritative roomId",
                { depositId: session.depositId }
            );

        }

        if (toBigInt(getters.gameIdHash) !== expectedGame) {

            throw this._reject(
                session.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                "On-chain gameId hash does not match authoritative gameId",
                { depositId: session.depositId }
            );

        }

        void plan;

    }

    _assertExpiresAt(getters, plan) {

        if (toBigInt(getters.expiresAt) !== toBigInt(plan.expiresAt)) {

            throw this._reject(
                plan.depositId,
                DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH,
                "On-chain expiresAt does not match authoritative configuration",
                { depositId: plan.depositId }
            );

        }

    }

    _waiting(session, contractState) {

        const verification = {
            status: DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT,
            depositId: session.depositId,
            depositAddress: session.depositAddress,
            accountState: contractState.state,
            verifiedAt: Date.now()
        };

        this._persistVerification(session.depositId, verification);

        this._emit(EVENT_TYPES.DEPOSIT_ACTIVATION_WAITING, session, verification);

        return Object.freeze({
            status: DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT,
            depositId: session.depositId,
            watchStarted: false
        });

    }

    _persistVerification(depositId, verification) {

        if (typeof this._depositSessionCoordinator?.recordActivationVerification !== "function") {

            return;

        }

        this._depositSessionCoordinator.recordActivationVerification(depositId, verification);

    }

    _startWatchIfNeeded(session) {

        if (!this._depositMonitor) {

            return;

        }

        if (typeof this._depositMonitor.authorizeVerifiedWatch === "function") {

            this._depositMonitor.authorizeVerifiedWatch(session.depositId);

        }

        if (typeof this._depositMonitor.startWatching === "function") {

            this._depositMonitor.startWatching(session);

        }

    }

    _hasWatch(depositId) {

        const watches = this._depositMonitor?.listActiveWatches?.() ?? [];

        return watches.some((watch) => watch.depositId === depositId);

    }

    _reject(depositId, code, message, details) {

        const session = this._depositSessionCoordinator?.getSession?.(depositId) ?? null;

        if (session) {

            this._persistVerification(depositId, {
                status: DEPOSIT_ACTIVATION_STATUS.REJECTED,
                code,
                message,
                rejectedAt: Date.now()
            });

            this._emit(EVENT_TYPES.DEPOSIT_ACTIVATION_REJECTED, session, {
                code,
                message,
                ...details
            });

        }

        return new DepositActivationVerificationError(message, code, details);

    }

    _assertNoFinancialSideEffects() {

        const service = this._tonService ?? this._blockchainSource?._tonService ?? null;

        if (service?.broadcastTransaction || service?.sendTransaction) {

            this._logger.warn(
                "DepositActivationVerificationCoordinator: TonService exposes send methods; they are not called"
            );

        }

        void this._gameContractManager;

        void this._deploymentAuthorizationCoordinator;

        void DEPOSIT_ONCHAIN_STATUS;

    }

    _emit(type, session, extra = {}) {

        if (!this._eventBus) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.DEPOSIT_ACTIVATION_VERIFICATION,
            type,
            payload: {
                depositId: session.depositId,
                roomId: session.roomId,
                gameId: session.gameId,
                depositAddress: session.depositAddress,
                state: session.state,
                ...extra
            }
        });

    }

}
