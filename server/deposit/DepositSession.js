/**
 * R17.9L.3 — DepositSession domain model.
 * One session per (roomId, gameId). No TON, no deployment gate.
 */

import { randomUUID } from "node:crypto";

import {
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialRecordTypes.js";
import { InvalidDepositStateTransitionError } from "./DepositSessionErrors.js";
import {
    assertDepositIdentity,
    assertFundingEvent,
    assertPlayerBindings
} from "./depositValidation.js";
import { computeDepositBindingHash } from "./deploymentAuthorizationHash.js";
import {
    canTransitionDepositStatus,
    DEPOSIT_SESSION_STATUS,
    isDepositSessionTerminal
} from "./DepositSessionStates.js";

export class DepositSession {

    constructor({
        depositId = null,
        roomId,
        gameId,
        bindings = [],
        state = DEPOSIT_SESSION_STATUS.CREATED,
        createdAt = Date.now(),
        updatedAt = null,
        boundAt = null,
        awaitingFundsAt = null,
        depositFullAt = null,
        expiredAt = null,
        authorizedAt = null,
        gameContractCreatedAt = null,
        releasedAt = null,
        reimbursedAt = null,
        refundStartedAt = null,
        refundedAt = null,
        fundingEventIds = [],
        expiresAt = null,
        depositAddress = null,
        bindingHash = null,
        authorizationHash = null,
        version = 1,
        correlationId = null,
        metadata = null
    } = {}) {

        const identity = assertDepositIdentity({ roomId, gameId });

        this.depositId = depositId ?? `dep_${randomUUID()}`;

        this.roomId = identity.roomId;

        this.gameId = identity.gameId;

        this.bindings = Array.isArray(bindings)
            ? bindings.map((binding) => ({ ...binding }))
            : [];

        this.state = state ?? DEPOSIT_SESSION_STATUS.CREATED;

        this.createdAt = createdAt;

        this.updatedAt = updatedAt ?? createdAt;

        this.boundAt = boundAt;

        this.awaitingFundsAt = awaitingFundsAt;

        this.depositFullAt = depositFullAt;

        this.expiredAt = expiredAt;

        this.authorizedAt = authorizedAt;

        this.gameContractCreatedAt = gameContractCreatedAt;

        this.releasedAt = releasedAt;

        this.reimbursedAt = reimbursedAt;

        this.refundStartedAt = refundStartedAt;

        this.refundedAt = refundedAt;

        this.fundingEventIds = [...(fundingEventIds ?? [])];

        this.expiresAt = expiresAt ?? null;

        this.depositAddress = depositAddress ?? null;

        this.bindingHash = bindingHash ?? null;

        this.authorizationHash = authorizationHash ?? null;

        this.version = Number(version) || 1;

        this.correlationId = correlationId ?? randomUUID();

        this.metadata = metadata && typeof metadata === "object"
            ? { ...metadata }
            : {};

    }

    static fromRecord(record) {

        const payload = record?.payload ?? record ?? {};

        return new DepositSession({
            depositId: payload.depositId ?? record?.recordId,
            roomId: payload.roomId,
            gameId: payload.gameId,
            bindings: payload.bindings ?? [],
            state: payload.state ?? payload.status ?? DEPOSIT_SESSION_STATUS.CREATED,
            createdAt: payload.createdAt ?? record?.createdAt ?? Date.now(),
            updatedAt: payload.updatedAt ?? record?.updatedAt ?? Date.now(),
            boundAt: payload.boundAt ?? null,
            awaitingFundsAt: payload.awaitingFundsAt ?? null,
            depositFullAt: payload.depositFullAt ?? null,
            expiredAt: payload.expiredAt ?? null,
            authorizedAt: payload.authorizedAt ?? null,
            gameContractCreatedAt: payload.gameContractCreatedAt ?? null,
            releasedAt: payload.releasedAt ?? null,
            reimbursedAt: payload.reimbursedAt ?? null,
            refundStartedAt: payload.refundStartedAt ?? null,
            refundedAt: payload.refundedAt ?? null,
            fundingEventIds: payload.fundingEventIds ?? [],
            expiresAt: payload.expiresAt ?? null,
            depositAddress: payload.depositAddress ?? null,
            bindingHash: payload.bindingHash ?? null,
            authorizationHash: payload.authorizationHash ?? null,
            version: payload.version ?? record?.version ?? 1,
            correlationId: payload.correlationId ?? record?.correlationId ?? null,
            metadata: payload.metadata ?? payload.recoveryMetadata ?? null
        });

    }

    transitionTo(nextState, patch = {}) {

        if (!canTransitionDepositStatus(this.state, nextState)) {

            throw new InvalidDepositStateTransitionError(
                this.depositId,
                this.state,
                nextState
            );

        }

        this.state = nextState;

        this.updatedAt = patch.updatedAt ?? Date.now();

        this.version += 1;

        return this;

    }

    bindPlayers(rawPlayers, identityLookups = {}) {

        assertDepositIdentity({
            roomId: this.roomId,
            gameId: this.gameId,
            ...identityLookups
        });

        const bindings = assertPlayerBindings(rawPlayers, {
            roomId: this.roomId,
            gameId: this.gameId,
            reservedWallets: identityLookups?.reservedWallets ?? null
        });

        this.transitionTo(DEPOSIT_SESSION_STATUS.PLAYER_BINDING);

        this.bindings = bindings.map((binding) => ({ ...binding }));

        this.bindingHash = computeDepositBindingHash({
            roomId: this.roomId,
            gameId: this.gameId,
            depositId: this.depositId,
            bindings: this.bindings
        });

        this.boundAt = Date.now();

        this.updatedAt = this.boundAt;

        return this;

    }

    markAwaitingFunds() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

        this.awaitingFundsAt = Date.now();

        this.updatedAt = this.awaitingFundsAt;

        const timeoutMs = Number(this.metadata?.depositTimeoutMs);

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {

            this.expiresAt = this.awaitingFundsAt + timeoutMs;

        }

        return this;

    }

    applyFunding({ wallet, amount, fundingEventId }) {

        if (
            this.state !== DEPOSIT_SESSION_STATUS.AWAITING_FUNDS
            && this.state !== DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED
        ) {

            throw new InvalidDepositStateTransitionError(
                this.depositId,
                this.state,
                DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED
            );

        }

        const { seat, eventId, amount: acceptedAmount } = assertFundingEvent(this, {
            wallet,
            amount,
            fundingEventId
        });

        seat.receivedAmount = acceptedAmount;

        seat.funded = true;

        seat.fundingEventId = eventId;

        seat.fundedAt = Date.now();

        this.fundingEventIds.push(eventId);

        this.updatedAt = seat.fundedAt;

        this.version += 1;

        if (this.isFullyFunded()) {

            this.transitionTo(DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

            this.depositFullAt = this.updatedAt;

        } else if (this.state === DEPOSIT_SESSION_STATUS.AWAITING_FUNDS) {

            this.transitionTo(DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED);

        }

        return this;

    }

    expire() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.EXPIRED);

        this.expiredAt = Date.now();

        this.updatedAt = this.expiredAt;

        return this;

    }

    startRefund() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.REFUNDING);

        this.refundStartedAt = Date.now();

        this.updatedAt = this.refundStartedAt;

        return this;

    }

    completeRefund() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.REFUNDED);

        this.refundedAt = Date.now();

        this.updatedAt = this.refundedAt;

        return this;

    }

    authorizeDeploy() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.DEPLOY_AUTHORIZED);

        this.authorizedAt = Date.now();

        this.updatedAt = this.authorizedAt;

        return this;

    }

    markGameContractCreated() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.GAME_CONTRACT_CREATED);

        this.gameContractCreatedAt = Date.now();

        this.updatedAt = this.gameContractCreatedAt;

        return this;

    }

    release() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.RELEASED);

        this.releasedAt = Date.now();

        this.updatedAt = this.releasedAt;

        return this;

    }

    reimburse() {

        this.transitionTo(DEPOSIT_SESSION_STATUS.REIMBURSED);

        this.reimbursedAt = Date.now();

        this.updatedAt = this.reimbursedAt;

        return this;

    }

    isFullyFunded() {

        return this.bindings.length > 0
            && this.bindings.every((binding) => binding.funded === true);

    }

    isTerminal() {

        return isDepositSessionTerminal(this.state);

    }

    /**
     * Overlay durable fields onto this instance (rollback / restore).
     */
    replaceFromRecord(record) {

        const next = DepositSession.fromRecord(record);

        this.depositId = next.depositId;

        this.roomId = next.roomId;

        this.gameId = next.gameId;

        this.bindings = next.bindings.map((binding) => ({ ...binding }));

        this.state = next.state;

        this.createdAt = next.createdAt;

        this.updatedAt = next.updatedAt;

        this.boundAt = next.boundAt;

        this.awaitingFundsAt = next.awaitingFundsAt;

        this.depositFullAt = next.depositFullAt;

        this.expiredAt = next.expiredAt;

        this.authorizedAt = next.authorizedAt;

        this.gameContractCreatedAt = next.gameContractCreatedAt;

        this.releasedAt = next.releasedAt;

        this.reimbursedAt = next.reimbursedAt;

        this.refundStartedAt = next.refundStartedAt;

        this.refundedAt = next.refundedAt;

        this.fundingEventIds = [...next.fundingEventIds];

        this.expiresAt = next.expiresAt;

        this.depositAddress = next.depositAddress;

        this.bindingHash = next.bindingHash;

        this.authorizationHash = next.authorizationHash;

        this.version = next.version;

        this.correlationId = next.correlationId;

        this.metadata = { ...next.metadata };

        return this;

    }

    toPayload() {

        return Object.freeze({
            depositId: this.depositId,
            roomId: this.roomId,
            gameId: this.gameId,
            state: this.state,
            status: this.state,
            bindings: this.bindings.map((binding) => Object.freeze({ ...binding })),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            boundAt: this.boundAt,
            awaitingFundsAt: this.awaitingFundsAt,
            depositFullAt: this.depositFullAt,
            expiredAt: this.expiredAt,
            expiresAt: this.expiresAt,
            authorizedAt: this.authorizedAt,
            gameContractCreatedAt: this.gameContractCreatedAt,
            releasedAt: this.releasedAt,
            reimbursedAt: this.reimbursedAt,
            refundStartedAt: this.refundStartedAt,
            refundedAt: this.refundedAt,
            fundingEventIds: Object.freeze([...this.fundingEventIds]),
            depositAddress: this.depositAddress,
            bindingHash: this.bindingHash,
            authorizationHash: this.authorizationHash,
            version: this.version,
            correlationId: this.correlationId,
            metadata: Object.freeze({ ...this.metadata })
        });

    }

    toSnapshot() {

        return this.toPayload();

    }

    /**
     * Envelope compatible with future TonFinancialPersistence deposit_session records.
     */
    toRecord() {

        const payload = this.toPayload();

        return Object.freeze({
            recordType: TON_FINANCIAL_RECORD_TYPES.DEPOSIT_SESSION,
            recordId: this.depositId,
            roomId: this.roomId,
            gameId: this.gameId,
            status: this.state,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            correlationId: this.correlationId,
            version: this.version,
            payload
        });

    }

}
