import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import { FailurePolicyManager } from "../failure/FailurePolicyManager.js";
import {
    BlockchainUnavailableError,
    InvalidBlockchainDataError,
    MonitorNotStartedError,
    MonitorRecoveryError,
    ObservationTimeoutError
} from "./BlockchainMonitorErrors.js";

/**
 * T2.5 — BlockchainMonitor lifecycle states.
 */
export const BLOCKCHAIN_MONITOR_STATE = Object.freeze({
    STOPPED: "STOPPED",
    STARTING: "STARTING",
    RUNNING: "RUNNING",
    DEGRADED: "DEGRADED",
    ERROR: "ERROR",
    SHUTDOWN: "SHUTDOWN"
});

/**
 * P6.6 — Immutable audit ledger for entry-payment blockchain events.
 */
export class EntryPaymentAuditLedger {

    constructor() {

        // roomId → frozen entry[]
        this._entriesByRoom = new Map();

    }

    append(roomId, entry) {

        if (!roomId || !entry) {

            return null;

        }

        const list = this._entriesByRoom.get(roomId) ?? [];

        const frozen = Object.freeze({
            ...entry,
            recordedAt: entry.recordedAt ?? Date.now()
        });

        list.push(frozen);

        this._entriesByRoom.set(roomId, list);

        return frozen;

    }

    list(roomId) {

        return Object.freeze([...(this._entriesByRoom.get(roomId) ?? [])]);

    }

    clearRoom(roomId) {

        this._entriesByRoom.delete(roomId);

    }

    clearAll() {

        this._entriesByRoom.clear();

    }

}

/**
 * Normalize GRM amounts for comparison (2 decimal places).
 */
export function amountsMatch(expected, actual) {

    const left = Number(expected);

    const right = Number(actual);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {

        return false;

    }

    return Math.round(left * 100) === Math.round(right * 100);

}

/**
 * Extract structured payment fields from a TonCenter transaction-like object.
 */
export function parseDepositCandidate(tx) {

    if (!tx || typeof tx !== "object") {

        return null;

    }

    const inMsg = tx.in_msg ?? tx.inMessage ?? null;

    if (!inMsg) {

        return null;

    }

    const sender = canonicalizeTonWalletAddress(
        inMsg.source
        ?? inMsg.sender
        ?? inMsg.from
        ?? null
    );

    const destination = canonicalizeTonWalletAddress(
        inMsg.destination
        ?? inMsg.recipient
        ?? inMsg.to
        ?? null
    );

    const comment = typeof inMsg.message === "string"
        ? inMsg.message
        : (
            typeof inMsg.comment === "string"
                ? inMsg.comment
                : (
                    typeof inMsg.msg_data?.text === "string"
                        ? inMsg.msg_data.text
                        : ""
                )
        );

    const amountRaw = inMsg.value
        ?? inMsg.amount
        ?? inMsg.jetton_amount
        ?? inMsg.jettonAmount
        ?? null;

    let amountGram = null;

    if (amountRaw != null) {

        const asNumber = Number(amountRaw);

        if (Number.isFinite(asNumber)) {

            // TonCenter value is nanotons; jetton monitors may pass GRM directly.
            amountGram = inMsg.amountIsGram === true
                || inMsg.currency === "GRM"
                ? asNumber
                : asNumber / 1e9;

        }

    }

    if (inMsg.grmAmount != null && Number.isFinite(Number(inMsg.grmAmount))) {

        amountGram = Number(inMsg.grmAmount);

    }

    const txHash = tx.transaction_id?.hash
        ?? tx.txHash
        ?? tx.hash
        ?? null;

    return {
        sender,
        destination,
        comment,
        amountGram,
        txHash,
        lt: tx.transaction_id?.lt ?? tx.lt ?? null,
        raw: tx
    };

}

/**
 * P6.6 / T2.5 — Observes TON blockchain facts for WheelWin contracts.
 *
 * Reports observation events only. Never owns payment / settlement decisions.
 * Communicates via TonService transport and optional TonGameContractAdapter.
 * Never imports @ton/* SDK.
 */
export class BlockchainMonitor {

    constructor({
        logger,
        eventBus,
        transport = null,
        tonService = null,
        contractAdapter = null,
        auditLedger = null,
        pollIntervalMs = 2000,
        transactionTimeoutMs = 120_000,
        deploymentTimeoutMs = 180_000,
        observationTimeoutMs = 300_000,
        emitEvent = null,
        eventTypes = null,
        now = () => Date.now()
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._transport = transport;

        this._tonService = tonService;

        this._contractAdapter = contractAdapter;

        this._auditLedger = auditLedger;

        this._pollIntervalMs = pollIntervalMs;

        this._transactionTimeoutMs = transactionTimeoutMs;

        this._deploymentTimeoutMs = deploymentTimeoutMs;

        this._observationTimeoutMs = observationTimeoutMs;

        this._emitEvent = emitEvent;

        this._eventTypes = eventTypes ?? {
            PAYMENT_BLOCKCHAIN_CONFIRMED: EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED,
            PAYMENT_BLOCKCHAIN_REJECTED: EVENT_TYPES.PAYMENT_BLOCKCHAIN_REJECTED
        };

        this._now = now;

        // Payment watches (legacy / PaymentSessionManager)
        this._watches = new Map();

        // roomId → Set(txHash)
        this._seenTxByRoom = new Map();

        // roomId → Set(paymentReference)
        this._confirmedRefsByRoom = new Map();

        // roomId → poll timer
        this._timers = new Map();

        // contractId → contract watch descriptor
        this._contracts = new Map();

        // watchId → transaction watch descriptor
        this._transactions = new Map();

        // global observation keys for duplicate protection
        this._emittedObservations = new Set();

        this._state = BLOCKCHAIN_MONITOR_STATE.STOPPED;

        this._initialized = false;

        this._startedAt = null;

        this._lastSuccessfulCheck = null;

        this._lastFailure = null;

        this._connected = false;

        this._network = null;

        this._globalPollTimer = null;

    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    initialize() {

        if (this._state === BLOCKCHAIN_MONITOR_STATE.SHUTDOWN) {

            this._state = BLOCKCHAIN_MONITOR_STATE.STOPPED;

        }

        this._initialized = true;

        this._state = BLOCKCHAIN_MONITOR_STATE.STOPPED;

        this._network = this._resolveNetwork();

    }

    async start() {

        this._assertInitialized();

        if (
            this._state === BLOCKCHAIN_MONITOR_STATE.RUNNING
            || this._state === BLOCKCHAIN_MONITOR_STATE.DEGRADED
        ) {

            return this.health();

        }

        this._state = BLOCKCHAIN_MONITOR_STATE.STARTING;

        try {

            await this._probeConnection();

            this._state = BLOCKCHAIN_MONITOR_STATE.RUNNING;

            this._startedAt = this._now();

            this._connected = true;

            this._network = this._resolveNetwork();

            this._ensureGlobalPoll();

            this._resumeRoomPolls();

            this._emitObservation(EVENT_TYPES.BLOCKCHAIN_CONNECTED, {
                network: this._network,
                timestamp: this._now()
            });

            return this.health();

        } catch (error) {

            this._state = BLOCKCHAIN_MONITOR_STATE.ERROR;

            this._connected = false;

            this._recordFailure("start", error);

            this._emitObservation(EVENT_TYPES.BLOCKCHAIN_DISCONNECTED, {
                network: this._network,
                timestamp: this._now(),
                reason: error?.message ?? "start_failed"
            });

            throw new BlockchainUnavailableError(
                error?.message ?? "Unable to start BlockchainMonitor",
                { cause: error?.code ?? null }
            );

        }

    }

    stop() {

        this._clearGlobalPoll();

        for (const roomId of [...this._timers.keys()]) {

            this._clearPoll(roomId);

        }

        if (this._state !== BLOCKCHAIN_MONITOR_STATE.SHUTDOWN) {

            this._state = BLOCKCHAIN_MONITOR_STATE.STOPPED;

        }

        this._connected = false;

        this._emitObservation(EVENT_TYPES.BLOCKCHAIN_DISCONNECTED, {
            network: this._network,
            timestamp: this._now(),
            reason: "stopped"
        });

        return this.health();

    }

    shutdown() {

        this.stop();

        this._watches.clear();

        this._seenTxByRoom.clear();

        this._confirmedRefsByRoom.clear();

        this._contracts.clear();

        this._transactions.clear();

        this._emittedObservations.clear();

        this._initialized = false;

        this._state = BLOCKCHAIN_MONITOR_STATE.SHUTDOWN;

        this._startedAt = null;

    }

    async restart() {

        const checkpoint = this.exportCheckpoint();

        this.stop();

        this.initialize();

        this.restoreCheckpoint(checkpoint);

        return this.start();

    }

    health() {

        return Object.freeze({
            state: this._state,
            connected: this._connected === true,
            network: this._network,
            watchedContracts: this._contracts.size,
            pendingTransactions: [...this._transactions.values()]
                .filter((entry) => entry.status === "PENDING").length,
            paymentWatches: this._watches.size,
            lastSuccessfulCheck: this._lastSuccessfulCheck,
            lastFailure: this._lastFailure
                ? Object.freeze({ ...this._lastFailure })
                : null,
            uptime: this._startedAt
                ? Math.max(0, this._now() - this._startedAt)
                : 0
        });

    }

    // -------------------------------------------------------------------------
    // Contract watch
    // -------------------------------------------------------------------------

    registerContract(contractId, address, {
        roomId = null,
        gameId = null,
        correlationId = null,
        expectDeployment = false
    } = {}) {

        this._assertReadyForWatch();

        if (!contractId || !address) {

            throw new InvalidBlockchainDataError(
                "registerContract requires contractId and address"
            );

        }

        const normalizedAddress = canonicalizeTonWalletAddress(address) ?? address;

        const existing = this._contracts.get(contractId);

        if (existing) {

            existing.address = normalizedAddress;

            existing.roomId = roomId ?? existing.roomId;

            existing.gameId = gameId ?? existing.gameId;

            existing.correlationId = correlationId ?? existing.correlationId;

            existing.expectDeployment = expectDeployment === true
                || existing.expectDeployment === true;

            existing.updatedAt = this._now();

            return this._publicContractWatch(existing);

        }

        const watch = {
            contractId,
            address: normalizedAddress,
            roomId,
            gameId,
            correlationId: correlationId ?? null,
            expectDeployment: expectDeployment === true,
            registeredAt: this._now(),
            updatedAt: this._now(),
            lastStatus: null,
            lastSeenAt: null,
            deploymentConfirmed: false
        };

        this._contracts.set(contractId, watch);

        this._ensureGlobalPoll();

        return this._publicContractWatch(watch);

    }

    unregisterContract(contractId) {

        this._contracts.delete(contractId);

        return true;

    }

    watchContract(contractId) {

        this._assertRunning();

        const watch = this._contracts.get(contractId);

        if (!watch) {

            throw new InvalidBlockchainDataError(
                `Contract is not registered | contractId=${contractId}`
            );

        }

        return this._observeContract(watch);

    }

    getContractStatus(contractId) {

        const watch = this._contracts.get(contractId);

        if (!watch) {

            return null;

        }

        return this._publicContractWatch(watch);

    }

    listWatchedContracts() {

        return Object.freeze(
            [...this._contracts.values()].map((watch) => this._publicContractWatch(watch))
        );

    }

    // -------------------------------------------------------------------------
    // Transaction watch
    // -------------------------------------------------------------------------

    watchTransaction({
        transactionId,
        address,
        contractId = null,
        roomId = null,
        gameId = null,
        correlationId = null,
        kind = "GENERIC",
        timeoutMs = null
    }) {

        this._assertReadyForWatch();

        if (!transactionId || !address) {

            throw new InvalidBlockchainDataError(
                "watchTransaction requires transactionId and address"
            );

        }

        const watchId = `${kind}:${transactionId}`;

        if (this._transactions.has(watchId)) {

            return this._publicTransactionWatch(this._transactions.get(watchId));

        }

        const watch = {
            watchId,
            transactionId: String(transactionId),
            address: canonicalizeTonWalletAddress(address) ?? address,
            contractId,
            roomId,
            gameId,
            correlationId,
            kind,
            status: "PENDING",
            startedAt: this._now(),
            timeoutMs: Number.isFinite(timeoutMs)
                ? timeoutMs
                : this._transactionTimeoutMs,
            confirmedAt: null,
            failedAt: null,
            reason: null
        };

        this._transactions.set(watchId, watch);

        this._ensureGlobalPoll();

        return this._publicTransactionWatch(watch);

    }

    async waitForConfirmation({
        transactionId,
        address,
        contractId = null,
        roomId = null,
        gameId = null,
        correlationId = null,
        kind = "GENERIC",
        timeoutMs = null,
        pollIntervalMs = null
    }) {

        this._assertRunning();

        const watch = this.watchTransaction({
            transactionId,
            address,
            contractId,
            roomId,
            gameId,
            correlationId,
            kind,
            timeoutMs
        });

        const deadline = this._now()
            + (Number.isFinite(timeoutMs) ? timeoutMs : this._transactionTimeoutMs);

        const interval = Math.max(
            50,
            Number(pollIntervalMs) || Math.min(this._pollIntervalMs, 500)
        );

        while (this._now() < deadline) {

            const current = this._transactions.get(watch.watchId);

            if (!current) {

                throw new ObservationTimeoutError("Transaction watch removed");

            }

            if (current.status === "CONFIRMED") {

                return this._publicTransactionWatch(current);

            }

            if (current.status === "FAILED") {

                throw new ObservationTimeoutError(
                    current.reason ?? "Transaction failed",
                    { transactionId }
                );

            }

            await this._observeTransaction(current);

            if (current.status === "CONFIRMED") {

                return this._publicTransactionWatch(current);

            }

            await this._sleep(interval);

        }

        const timedOut = this._transactions.get(watch.watchId);

        if (timedOut) {

            timedOut.status = "FAILED";

            timedOut.failedAt = this._now();

            timedOut.reason = "observation_timeout";

            this._emitObservation(EVENT_TYPES.TRANSACTION_FAILED, {
                contractId: timedOut.contractId,
                transactionId: timedOut.transactionId,
                address: timedOut.address,
                network: this._network,
                timestamp: this._now(),
                correlationId: timedOut.correlationId,
                reason: "observation_timeout"
            });

        }

        throw new ObservationTimeoutError(
            "waitForConfirmation timed out",
            { transactionId }
        );

    }

    detectSuccess(transactionId, kind = "GENERIC") {

        const watch = this._transactions.get(`${kind}:${transactionId}`);

        return watch?.status === "CONFIRMED";

    }

    detectFailure(transactionId, kind = "GENERIC") {

        const watch = this._transactions.get(`${kind}:${transactionId}`);

        return watch?.status === "FAILED";

    }

    // -------------------------------------------------------------------------
    // Recovery checkpoint (temporary monitor state only)
    // -------------------------------------------------------------------------

    exportCheckpoint() {

        return Object.freeze({
            exportedAt: this._now(),
            network: this._network,
            contracts: Object.freeze(
                [...this._contracts.values()].map((watch) => Object.freeze({
                    ...watch
                }))
            ),
            transactions: Object.freeze(
                [...this._transactions.values()]
                    .filter((watch) => watch.status === "PENDING")
                    .map((watch) => Object.freeze({ ...watch }))
            ),
            paymentWatches: Object.freeze(
                [...this._watches.values()].map((watch) => Object.freeze({
                    ...watch
                }))
            ),
            seenTxByRoom: Object.freeze(
                Object.fromEntries(
                    [...this._seenTxByRoom.entries()].map(([roomId, set]) => [
                        roomId,
                        Object.freeze([...set])
                    ])
                )
            ),
            confirmedRefsByRoom: Object.freeze(
                Object.fromEntries(
                    [...this._confirmedRefsByRoom.entries()].map(([roomId, set]) => [
                        roomId,
                        Object.freeze([...set])
                    ])
                )
            ),
            emittedObservations: Object.freeze([...this._emittedObservations])
        });

    }

    restoreCheckpoint(checkpoint) {

        if (!checkpoint || typeof checkpoint !== "object") {

            throw new MonitorRecoveryError("Invalid monitor checkpoint");

        }

        try {

            this._contracts.clear();

            for (const entry of checkpoint.contracts ?? []) {

                this._contracts.set(entry.contractId, { ...entry });

            }

            this._transactions.clear();

            for (const entry of checkpoint.transactions ?? []) {

                this._transactions.set(entry.watchId, { ...entry });

            }

            this._watches.clear();

            for (const entry of checkpoint.paymentWatches ?? []) {

                const key = this._watchKey(entry.roomId, entry.playerId);

                this._watches.set(key, { ...entry });

            }

            this._seenTxByRoom.clear();

            for (const [roomId, hashes] of Object.entries(checkpoint.seenTxByRoom ?? {})) {

                this._seenTxByRoom.set(roomId, new Set(hashes));

            }

            this._confirmedRefsByRoom.clear();

            for (const [roomId, refs] of Object.entries(checkpoint.confirmedRefsByRoom ?? {})) {

                this._confirmedRefsByRoom.set(roomId, new Set(refs));

            }

            this._emittedObservations = new Set(checkpoint.emittedObservations ?? []);

            this._network = checkpoint.network ?? this._resolveNetwork();

            return true;

        } catch (error) {

            throw new MonitorRecoveryError(
                "Unable to restore BlockchainMonitor checkpoint",
                { cause: error?.message ?? null }
            );

        }

    }

    // -------------------------------------------------------------------------
    // Legacy payment observation API (PaymentSessionManager)
    // -------------------------------------------------------------------------

    /**
     * Watch one player's expected deposit into the game escrow.
     */
    watchPayment({
        roomId,
        gameId,
        playerId,
        contractAddress,
        paymentReference,
        expectedGram,
        expectedWallet,
        paymentDeadline = null,
        contractId = null,
        correlationId = null
    }) {

        if (!this._initialized) {

            throw new Error("BlockchainMonitor is not initialized");

        }

        const key = this._watchKey(roomId, playerId);

        this._watches.set(key, {
            roomId,
            gameId,
            playerId,
            contractId,
            correlationId,
            contractAddress: canonicalizeTonWalletAddress(contractAddress)
                ?? contractAddress,
            paymentReference,
            expectedGram: Number(expectedGram),
            expectedWallet: canonicalizeTonWalletAddress(expectedWallet),
            paymentDeadline,
            startedAt: this._now()
        });

        if (
            this._state === BLOCKCHAIN_MONITOR_STATE.RUNNING
            || this._state === BLOCKCHAIN_MONITOR_STATE.DEGRADED
            || this._state === BLOCKCHAIN_MONITOR_STATE.STOPPED
        ) {

            // Auto-start polls for backward compatibility with app.js initialize-only path.
            if (this._state === BLOCKCHAIN_MONITOR_STATE.STOPPED) {

                this._state = BLOCKCHAIN_MONITOR_STATE.RUNNING;

                this._startedAt = this._startedAt ?? this._now();

                this._connected = true;

            }

            this._ensurePoll(roomId);

        }

        this._audit(roomId, {
            type: "WATCH_STARTED",
            gameId,
            playerId,
            contractAddress,
            paymentReference,
            expectedGram,
            expectedWallet
        });

        return key;

    }

    unwatchPayment(roomId, playerId) {

        const key = this._watchKey(roomId, playerId);

        this._watches.delete(key);

        const remaining = [...this._watches.values()].some(
            (watch) => watch.roomId === roomId
        );

        if (!remaining) {

            this._clearPoll(roomId);

        }

    }

    stopRoom(roomId) {

        for (const [key, watch] of [...this._watches.entries()]) {

            if (watch.roomId === roomId) {

                this._watches.delete(key);

            }

        }

        this._clearPoll(roomId);

        this._seenTxByRoom.delete(roomId);

        this._confirmedRefsByRoom.delete(roomId);

        // P6.7 — audit trail is immutable; do not clear on watch stop.

    }

    /**
     * Test / push path: ingest one transport transaction for a room contract.
     */
    async ingestTransaction(roomId, tx) {

        const watches = [...this._watches.values()].filter(
            (watch) => watch.roomId === roomId
        );

        const deposit = parseDepositCandidate(tx);

        const txHash = deposit?.txHash ? String(deposit.txHash) : null;

        if (txHash) {

            const seen = this._seenTxByRoom.get(roomId) ?? new Set();

            if (seen.has(txHash)) {

                this._audit(roomId, {
                    type: "DUPLICATE_PAYMENT",
                    txHash,
                    sender: deposit?.sender ?? null,
                    amount: deposit?.amountGram ?? null,
                    reason: "duplicate_payment"
                });

                return;

            }

        }

        if (watches.length === 0) {

            return;

        }

        await this._evaluateTransaction(watches[0].contractAddress, tx, watches);

    }

    // -------------------------------------------------------------------------
    // Polling
    // -------------------------------------------------------------------------

    _ensureGlobalPoll() {

        if (this._globalPollTimer) {

            return;

        }

        if (
            this._state !== BLOCKCHAIN_MONITOR_STATE.RUNNING
            && this._state !== BLOCKCHAIN_MONITOR_STATE.DEGRADED
        ) {

            return;

        }

        this._globalPollTimer = setInterval(() => {

            void this._pollGlobal();

        }, this._pollIntervalMs);

        void this._pollGlobal();

    }

    _clearGlobalPoll() {

        if (this._globalPollTimer) {

            clearInterval(this._globalPollTimer);

            this._globalPollTimer = null;

        }

    }

    _resumeRoomPolls() {

        const roomIds = new Set(
            [...this._watches.values()].map((watch) => watch.roomId)
        );

        for (const roomId of roomIds) {

            this._ensurePoll(roomId);

        }

    }

    async _pollGlobal() {

        if (
            this._state !== BLOCKCHAIN_MONITOR_STATE.RUNNING
            && this._state !== BLOCKCHAIN_MONITOR_STATE.DEGRADED
        ) {

            return;

        }

        try {

            let observed = false;

            for (const watch of this._contracts.values()) {

                await this._observeContract(watch);

                observed = true;

            }

            for (const watch of [...this._transactions.values()]) {

                if (watch.status === "PENDING") {

                    await this._observeTransaction(watch);

                    observed = true;

                }

            }

            if (observed) {

                this._lastSuccessfulCheck = this._now();

                if (this._state === BLOCKCHAIN_MONITOR_STATE.DEGRADED) {

                    this._state = BLOCKCHAIN_MONITOR_STATE.RUNNING;

                    this._connected = true;

                }

            }

        } catch (error) {

            this._recordFailure("poll_global", error);

            this._state = BLOCKCHAIN_MONITOR_STATE.DEGRADED;

            this._connected = false;

        }

    }

    _ensurePoll(roomId) {

        if (this._timers.has(roomId)) {

            return;

        }

        const timerId = setInterval(() => {

            void this._pollRoom(roomId);

        }, this._pollIntervalMs);

        this._timers.set(roomId, timerId);

        void this._pollRoom(roomId);

    }

    _clearPoll(roomId) {

        const timerId = this._timers.get(roomId);

        if (timerId) {

            clearInterval(timerId);

            this._timers.delete(roomId);

        }

    }

    async _pollRoom(roomId) {

        const watches = [...this._watches.values()].filter(
            (watch) => watch.roomId === roomId
        );

        if (watches.length === 0) {

            this._clearPoll(roomId);

            return;

        }

        const contractAddress = watches[0].contractAddress;

        let transactions = [];

        try {

            transactions = await this._fetchTransactions(contractAddress, {
                limit: 30
            });

            this._lastSuccessfulCheck = this._now();

            this._connected = true;

            if (this._state === BLOCKCHAIN_MONITOR_STATE.DEGRADED) {

                this._state = BLOCKCHAIN_MONITOR_STATE.RUNNING;

            }

        } catch (error) {

            this._logger?.warn?.(
                `BlockchainMonitor poll failed | roomId=${roomId} | `
                    + `${error?.message ?? error}`
            );

            this._recordFailure("poll_room", error);

            this._state = BLOCKCHAIN_MONITOR_STATE.DEGRADED;

            this._connected = false;

            try {

                const policy = FailurePolicyManager.getInstance();

                if (policy.isEnabled()) {

                    policy.decide({
                        component: "blockchain",
                        operation: "poll_room",
                        error,
                        fields: { roomId }
                    });

                }

            } catch {
                // Failure policy is observational for poll errors.
            }

            return;

        }

        for (const tx of transactions ?? []) {

            await this._evaluateTransaction(contractAddress, tx, watches);

        }

        const now = this._now();

        for (const watch of watches) {

            if (
                Number.isFinite(watch.paymentDeadline)
                && now > watch.paymentDeadline
            ) {

                this._audit(roomId, {
                    type: "PAYMENT_EXPIRED",
                    playerId: watch.playerId,
                    paymentReference: watch.paymentReference,
                    reason: "expired_payment"
                });

                this._emit("PAYMENT_BLOCKCHAIN_REJECTED", {
                    roomId,
                    gameId: watch.gameId,
                    playerId: watch.playerId,
                    reason: "expired_payment"
                });

                this.unwatchPayment(roomId, watch.playerId);

            }

        }

    }

    async _observeContract(watch) {

        watch.lastSeenAt = this._now();

        if (this._contractAdapter?.getContractState) {

            try {

                const state = await this._contractAdapter.getContractState(
                    watch.address
                );

                const previous = watch.lastStatus;

                watch.lastStatus = state?.status ?? null;

                watch.updatedAt = this._now();

                this._lastSuccessfulCheck = this._now();

                if (
                    previous
                    && watch.lastStatus
                    && previous !== watch.lastStatus
                ) {

                    this._emitObservation(
                        EVENT_TYPES.BLOCKCHAIN_CONTRACT_STATE_CHANGED,
                        {
                            contractId: watch.contractId,
                            address: watch.address,
                            network: this._network,
                            timestamp: this._now(),
                            correlationId: watch.correlationId,
                            previousStatus: previous,
                            status: watch.lastStatus
                        },
                        `contract-state:${watch.contractId}:${watch.lastStatus}`
                    );

                }

                if (
                    watch.expectDeployment
                    && !watch.deploymentConfirmed
                    && state?.exists !== false
                    && watch.lastStatus
                    && watch.lastStatus !== "UNINITIALIZED"
                ) {

                    watch.deploymentConfirmed = true;

                    this._emitObservation(
                        EVENT_TYPES.CONTRACT_DEPLOYMENT_CONFIRMED,
                        {
                            contractId: watch.contractId,
                            address: watch.address,
                            network: this._network,
                            timestamp: this._now(),
                            correlationId: watch.correlationId,
                            status: watch.lastStatus
                        },
                        `deploy-confirmed:${watch.contractId}`
                    );

                }

                if (
                    watch.expectDeployment
                    && !watch.deploymentConfirmed
                    && Number.isFinite(this._deploymentTimeoutMs)
                    && (this._now() - watch.registeredAt) > this._deploymentTimeoutMs
                ) {

                    this._emitObservation(
                        EVENT_TYPES.CONTRACT_DEPLOYMENT_FAILED,
                        {
                            contractId: watch.contractId,
                            address: watch.address,
                            network: this._network,
                            timestamp: this._now(),
                            correlationId: watch.correlationId,
                            reason: "deployment_timeout"
                        },
                        `deploy-failed:${watch.contractId}`
                    );

                    watch.expectDeployment = false;

                }

                return this._publicContractWatch(watch);

            } catch (error) {

                this._recordFailure("observe_contract", error);

                this._state = BLOCKCHAIN_MONITOR_STATE.DEGRADED;

            }

        }

        // Fallback: account activity via transport / TonService.
        try {

            const account = await this._fetchAccount(watch.address);

            watch.lastStatus = account?.state ?? watch.lastStatus;

            watch.updatedAt = this._now();

            this._lastSuccessfulCheck = this._now();

            if (
                watch.expectDeployment
                && !watch.deploymentConfirmed
                && account?.state === "active"
            ) {

                watch.deploymentConfirmed = true;

                this._emitObservation(
                    EVENT_TYPES.CONTRACT_DEPLOYMENT_CONFIRMED,
                    {
                        contractId: watch.contractId,
                        address: watch.address,
                        network: this._network,
                        timestamp: this._now(),
                        correlationId: watch.correlationId,
                        status: account.state
                    },
                    `deploy-confirmed:${watch.contractId}`
                );

            }

        } catch (error) {

            this._recordFailure("observe_contract_account", error);

            this._state = BLOCKCHAIN_MONITOR_STATE.DEGRADED;

        }

        return this._publicContractWatch(watch);

    }

    async _observeTransaction(watch) {

        if (
            Number.isFinite(watch.timeoutMs)
            && (this._now() - watch.startedAt) > watch.timeoutMs
        ) {

            watch.status = "FAILED";

            watch.failedAt = this._now();

            watch.reason = "observation_timeout";

            this._emitObservation(EVENT_TYPES.TRANSACTION_FAILED, {
                contractId: watch.contractId,
                transactionId: watch.transactionId,
                address: watch.address,
                network: this._network,
                timestamp: this._now(),
                correlationId: watch.correlationId,
                reason: "observation_timeout",
                kind: watch.kind
            });

            return this._publicTransactionWatch(watch);

        }

        try {

            const transactions = await this._fetchTransactions(watch.address, {
                limit: 30
            });

            const match = (transactions ?? []).find((tx) => {

                const hash = String(
                    tx?.transaction_id?.hash
                    ?? tx?.txHash
                    ?? tx?.hash
                    ?? ""
                );

                return hash === String(watch.transactionId);

            });

            this._lastSuccessfulCheck = this._now();

            if (!match) {

                return this._publicTransactionWatch(watch);

            }

            if (match.aborted === true || match.description === "failed") {

                watch.status = "FAILED";

                watch.failedAt = this._now();

                watch.reason = "transaction_failed";

                this._emitObservation(EVENT_TYPES.TRANSACTION_FAILED, {
                    contractId: watch.contractId,
                    transactionId: watch.transactionId,
                    address: watch.address,
                    network: this._network,
                    timestamp: this._now(),
                    correlationId: watch.correlationId,
                    kind: watch.kind
                });

                return this._publicTransactionWatch(watch);

            }

            watch.status = "CONFIRMED";

            watch.confirmedAt = this._now();

            if (watch.kind === "SETTLEMENT") {

                this._emitObservation(
                    EVENT_TYPES.SETTLEMENT_TRANSACTION_CONFIRMED,
                    {
                        contractId: watch.contractId,
                        transactionId: watch.transactionId,
                        address: watch.address,
                        network: this._network,
                        timestamp: this._now(),
                        correlationId: watch.correlationId
                    },
                    `settlement-confirmed:${watch.transactionId}`
                );

            } else if (watch.kind === "PAYMENT") {

                this._emitObservation(
                    EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
                    {
                        contractId: watch.contractId,
                        transactionId: watch.transactionId,
                        address: watch.address,
                        network: this._network,
                        timestamp: this._now(),
                        correlationId: watch.correlationId
                    },
                    `payment-tx-confirmed:${watch.transactionId}`
                );

            }

            return this._publicTransactionWatch(watch);

        } catch (error) {

            this._recordFailure("observe_transaction", error);

            this._state = BLOCKCHAIN_MONITOR_STATE.DEGRADED;

            return this._publicTransactionWatch(watch);

        }

    }

    async _evaluateTransaction(contractAddress, tx, watches) {

        const deposit = parseDepositCandidate(tx);

        if (!deposit) {

            return;

        }

        const roomId = watches[0]?.roomId;

        const txHash = deposit.txHash
            ? String(deposit.txHash)
            : null;

        if (txHash && roomId) {

            const seen = this._seenTxByRoom.get(roomId) ?? new Set();

            if (seen.has(txHash)) {

                this._audit(roomId, {
                    type: "DUPLICATE_PAYMENT",
                    txHash,
                    sender: deposit.sender,
                    amount: deposit.amountGram,
                    reason: "duplicate_payment"
                });

                return;

            }

        }

        const destination = canonicalizeTonWalletAddress(deposit.destination)
            ?? deposit.destination;

        const normalizedContract = canonicalizeTonWalletAddress(contractAddress)
            ?? contractAddress;

        if (
            destination
            && normalizedContract
            && destination !== normalizedContract
        ) {

            this._markSeen(roomId, txHash);

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                reason: "wrong_contract",
                sender: deposit.sender,
                amount: deposit.amountGram
            });

            return;

        }

        const matchingWatch = watches.find((watch) => (
            Boolean(deposit.comment?.includes(watch.paymentReference))
        ));

        if (!matchingWatch) {

            const confirmedRefs = this._confirmedRefsByRoom.get(roomId) ?? new Set();

            const duplicateRef = [...confirmedRefs].find(
                (reference) => deposit.comment?.includes(reference)
            );

            this._markSeen(roomId, txHash);

            if (duplicateRef) {

                this._audit(roomId, {
                    type: "DUPLICATE_PAYMENT",
                    txHash,
                    paymentReference: duplicateRef,
                    sender: deposit.sender,
                    amount: deposit.amountGram,
                    reason: "duplicate_payment"
                });

                return;

            }

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                reason: "unknown_payment_reference",
                sender: deposit.sender,
                amount: deposit.amountGram,
                comment: deposit.comment
            });

            return;

        }

        this._emitObservation(
            EVENT_TYPES.PAYMENT_TRANSACTION_DETECTED,
            {
                contractId: matchingWatch.contractId ?? null,
                transactionId: txHash,
                address: matchingWatch.contractAddress,
                network: this._network,
                timestamp: this._now(),
                correlationId: matchingWatch.correlationId ?? null,
                roomId,
                gameId: matchingWatch.gameId,
                playerId: matchingWatch.playerId,
                paymentReference: matchingWatch.paymentReference
            },
            txHash ? `payment-detected:${txHash}` : null
        );

        if (
            matchingWatch.expectedWallet
            && deposit.sender
            && deposit.sender !== matchingWatch.expectedWallet
        ) {

            this._markSeen(roomId, txHash);

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                playerId: matchingWatch.playerId,
                reason: "wrong_sender",
                sender: deposit.sender,
                expectedWallet: matchingWatch.expectedWallet,
                amount: deposit.amountGram
            });

            this._emit("PAYMENT_BLOCKCHAIN_REJECTED", {
                roomId,
                gameId: matchingWatch.gameId,
                playerId: matchingWatch.playerId,
                reason: "wrong_sender",
                txHash
            });

            return;

        }

        if (!amountsMatch(matchingWatch.expectedGram, deposit.amountGram)) {

            this._markSeen(roomId, txHash);

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                playerId: matchingWatch.playerId,
                reason: "insufficient_amount",
                sender: deposit.sender,
                amount: deposit.amountGram,
                expectedGram: matchingWatch.expectedGram
            });

            this._emit("PAYMENT_BLOCKCHAIN_REJECTED", {
                roomId,
                gameId: matchingWatch.gameId,
                playerId: matchingWatch.playerId,
                reason: "insufficient_amount",
                txHash
            });

            return;

        }

        this._markSeen(roomId, txHash);

        const confirmedRefs = this._confirmedRefsByRoom.get(roomId) ?? new Set();

        confirmedRefs.add(matchingWatch.paymentReference);

        this._confirmedRefsByRoom.set(roomId, confirmedRefs);

        this._audit(roomId, {
            type: "PAYMENT_CONFIRMED",
            txHash,
            playerId: matchingWatch.playerId,
            sender: deposit.sender,
            amount: deposit.amountGram,
            paymentReference: matchingWatch.paymentReference,
            contractAddress: matchingWatch.contractAddress,
            confirmationTime: this._now()
        });

        this._emitObservation(
            EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
            {
                contractId: matchingWatch.contractId ?? null,
                transactionId: txHash,
                address: matchingWatch.contractAddress,
                network: this._network,
                timestamp: this._now(),
                correlationId: matchingWatch.correlationId ?? null,
                roomId,
                gameId: matchingWatch.gameId,
                playerId: matchingWatch.playerId,
                paymentReference: matchingWatch.paymentReference
            },
            txHash ? `payment-confirmed:${txHash}` : null
        );

        // Business-facing fact for PaymentSessionManager (unchanged).
        this._emit("PAYMENT_BLOCKCHAIN_CONFIRMED", {
            roomId,
            gameId: matchingWatch.gameId,
            playerId: matchingWatch.playerId,
            txHash,
            sender: deposit.sender,
            amount: deposit.amountGram,
            paymentReference: matchingWatch.paymentReference,
            contractAddress: matchingWatch.contractAddress,
            confirmedAt: this._now()
        });

        this.unwatchPayment(roomId, matchingWatch.playerId);

    }

    // -------------------------------------------------------------------------
    // Transport helpers (TonService preferred, transport fallback)
    // -------------------------------------------------------------------------

    async _fetchTransactions(address, query = {}) {

        if (this._tonService?.getTransactions) {

            return this._tonService.getTransactions(address, query);

        }

        if (this._transport?.getTransactions) {

            return this._transport.getTransactions(address, query);

        }

        throw new BlockchainUnavailableError("No TON transport available");

    }

    async _fetchAccount(address) {

        if (this._tonService?.getAccount) {

            return this._tonService.getAccount(address);

        }

        if (this._transport?.getAddressInformation) {

            return this._transport.getAddressInformation(address);

        }

        throw new BlockchainUnavailableError("No TON account transport available");

    }

    async _probeConnection() {

        if (this._tonService?.health) {

            const health = this._tonService.health();

            if (health?.connected === false) {

                throw new BlockchainUnavailableError("TonService is not connected");

            }

            this._network = health.network ?? this._resolveNetwork();

            this._lastSuccessfulCheck = this._now();

            return;

        }

        if (this._transport?.getAddressInformation) {

            // Lightweight probe — transport exists; no remote call required at start.
            this._lastSuccessfulCheck = this._now();

            return;

        }

        if (!this._transport && !this._tonService) {

            throw new BlockchainUnavailableError(
                "BlockchainMonitor requires tonService or transport"
            );

        }

    }

    _resolveNetwork() {

        return this._tonService?.getActiveNetwork?.()
            ?? this._tonService?.getConfig?.()?.network
            ?? null;

    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    _markSeen(roomId, txHash) {

        if (!roomId || !txHash) {

            return;

        }

        const seen = this._seenTxByRoom.get(roomId) ?? new Set();

        seen.add(String(txHash));

        this._seenTxByRoom.set(roomId, seen);

    }

    _watchKey(roomId, playerId) {

        return `${roomId}::${playerId}`;

    }

    _audit(roomId, entry) {

        if (!roomId) {

            return;

        }

        this._auditLedger?.append(roomId, entry);

    }

    _emit(typeName, payload) {

        const type = this._eventTypes?.[typeName] ?? typeName;

        if (this._emitEvent) {

            this._emitEvent(type, payload);

            return;

        }

        if (this._eventBus) {

            this._eventBus.emit({
                source: EVENT_SOURCES.BLOCKCHAIN_MONITOR,
                type,
                payload
            });

        }

    }

    _emitObservation(type, payload, dedupeKey = null) {

        if (dedupeKey) {

            if (this._emittedObservations.has(dedupeKey)) {

                return;

            }

            this._emittedObservations.add(dedupeKey);

        }

        this._emit(type, {
            network: this._network,
            timestamp: this._now(),
            ...payload
        });

    }

    _publicContractWatch(watch) {

        return Object.freeze({
            contractId: watch.contractId,
            address: watch.address,
            roomId: watch.roomId,
            gameId: watch.gameId,
            correlationId: watch.correlationId,
            lastStatus: watch.lastStatus,
            deploymentConfirmed: watch.deploymentConfirmed === true,
            registeredAt: watch.registeredAt,
            updatedAt: watch.updatedAt,
            lastSeenAt: watch.lastSeenAt
        });

    }

    _publicTransactionWatch(watch) {

        return Object.freeze({
            watchId: watch.watchId,
            transactionId: watch.transactionId,
            address: watch.address,
            contractId: watch.contractId,
            roomId: watch.roomId,
            gameId: watch.gameId,
            correlationId: watch.correlationId,
            kind: watch.kind,
            status: watch.status,
            startedAt: watch.startedAt,
            confirmedAt: watch.confirmedAt,
            failedAt: watch.failedAt,
            reason: watch.reason
        });

    }

    _recordFailure(operation, error) {

        this._lastFailure = Object.freeze({
            at: this._now(),
            operation,
            message: error?.message ?? String(error),
            code: error?.code ?? error?.name ?? "MONITOR_ERROR"
        });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("BlockchainMonitor is not initialized");

        }

    }

    _assertReadyForWatch() {

        this._assertInitialized();

        if (this._state === BLOCKCHAIN_MONITOR_STATE.SHUTDOWN) {

            throw new MonitorNotStartedError();

        }

    }

    _assertRunning() {

        this._assertInitialized();

        if (
            this._state !== BLOCKCHAIN_MONITOR_STATE.RUNNING
            && this._state !== BLOCKCHAIN_MONITOR_STATE.DEGRADED
        ) {

            throw new MonitorNotStartedError();

        }

    }

    _sleep(ms) {

        return new Promise((resolve) => setTimeout(resolve, ms));

    }

}

export {
    BlockchainUnavailableError,
    DuplicateObservationError,
    InvalidBlockchainDataError,
    MonitorNotStartedError,
    MonitorRecoveryError,
    ObservationTimeoutError
} from "./BlockchainMonitorErrors.js";
