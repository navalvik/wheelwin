/**
 * R17.9L.13 — Read-only TON adapter for DepositMonitor.
 *
 * Observation layer only. Cannot send TON, cannot sign, cannot use Deploy Wallet,
 * no DepositSession mutation, and does not create authorization objects.
 *
 * Read path:
 *   DepositMonitor.poll()
 *     → RealTonDepositBlockchainSource.poll()
 *       → TonService.getAccount / getTransactions / runGetMethod
 *         → TonCenterTransport
 *           → TON RPC
 */

import { Address, Cell, beginCell } from "@ton/core";

import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import { isFailedTonTransaction } from "../payment/BlockchainMonitor.js";
import { loadDepositCodeCell } from "../payment/ton/buildDepositStateInit.js";
import { readFullDepositGetters } from "../payment/ton/readDepositGetters.js";
import { assertVerifiedDepositArtifact } from "../payment/ton/verifyDepositArtifact.js";
import {
    InvalidResponseError,
    NetworkUnavailableError,
    TimeoutError,
    UnsupportedNetworkError
} from "../services/ton/TonServiceErrors.js";
import { isInfrastructureFailure } from "../services/ton/TonServiceRetry.js";
import { DepositObservation } from "./DepositObservation.js";
import { normalizeDepositWallet } from "./depositValidation.js";

export const FUND_SEAT_OPCODE = 0x46554E44;

export const DEPOSIT_ACCOUNT_STATE = Object.freeze({
    NONEXISTENT: "NONEXISTENT",
    UNINIT: "UNINIT",
    ACTIVE: "ACTIVE",
    FROZEN: "FROZEN"
});

export const DEPOSIT_ONCHAIN_STATUS = Object.freeze({
    UNINITIALIZED: 0,
    AWAITING_FUNDS: 1,
    PARTIALLY_FUNDED: 2,
    FULL: 3,
    RELEASED: 4,
    REFUNDING: 5,
    REFUNDED: 6,
    EXPIRED: 7
});

export const DEPOSIT_NETWORK_TAG = Object.freeze({
    testnet: 0,
    mainnet: 1
});

const SUPPORTED_NETWORKS = Object.freeze(["testnet", "mainnet"]);
const TX_PAGE_LIMIT = 32;

export class DepositBlockchainSourceError extends Error {

    constructor(message, details = {}) {

        super(message);

        this.name = "DepositBlockchainSourceError";

        this.details = Object.freeze({ ...details });

    }

}

function normalizeNetwork(network) {

    return String(network ?? "").trim().toLowerCase();

}

function assertSupportedNetwork(network) {

    const normalized = normalizeNetwork(network);

    if (!SUPPORTED_NETWORKS.includes(normalized)) {

        throw new UnsupportedNetworkError(network);

    }

    return normalized;

}

function expectedNetworkTag(network) {

    return DEPOSIT_NETWORK_TAG[assertSupportedNetwork(network)];

}

function toFriendlyAddress(value) {

    if (value instanceof Address) {

        return value.toString({ bounceable: true, urlSafe: true });

    }

    if (typeof value === "string" && value.trim()) {

        return canonicalizeTonWalletAddress(value.trim()) ?? value.trim();

    }

    return null;

}

function parseBodyCell(bodyB64) {

    if (typeof bodyB64 !== "string" || !bodyB64.trim()) {

        return null;

    }

    try {

        return Cell.fromBase64(bodyB64.trim());

    } catch {

        try {

            const cells = Cell.fromBoc(Buffer.from(bodyB64.trim(), "base64"));

            return cells[0] ?? null;

        } catch {

            return null;

        }

    }

}

/**
 * Decode FundSeat { seatIndex: uint8 } from an inbound message body.
 * Opcode is the compiled Tact value 0x46554E44 ("FUND").
 *
 * @param {Cell|string|null} body
 * @returns {{ opcode: number, seatIndex: number }|null}
 */
export function decodeFundSeatBody(body) {

    const cell = body instanceof Cell ? body : parseBodyCell(body);

    if (!cell) {

        return null;

    }

    try {

        const slice = cell.beginParse();

        if (slice.remainingBits < 40) {

            return null;

        }

        const opcode = slice.loadUint(32);

        if (opcode !== FUND_SEAT_OPCODE) {

            return null;

        }

        const seatIndex = slice.loadUint(8);

        if (seatIndex < 0 || seatIndex > 2) {

            return null;

        }

        return { opcode, seatIndex };

    } catch {

        return null;

    }

}

export function encodeFundSeatBody(seatIndex) {

    return beginCell()
        .storeUint(FUND_SEAT_OPCODE, 32)
        .storeUint(Number(seatIndex) & 0xff, 8)
        .endCell();

}

function mapAccountState(info) {

    if (!info || typeof info !== "object") {

        return DEPOSIT_ACCOUNT_STATE.NONEXISTENT;

    }

    const raw = String(info.state ?? info.account_state ?? "").trim().toLowerCase();
    const hasCode = Boolean(info.code && String(info.code).trim());

    if (raw === "frozen") {

        return DEPOSIT_ACCOUNT_STATE.FROZEN;

    }

    if (raw === "nonexist" || raw === "nonexistent" || raw === "notfound") {

        return DEPOSIT_ACCOUNT_STATE.NONEXISTENT;

    }

    if (raw === "active") {

        return hasCode ? DEPOSIT_ACCOUNT_STATE.ACTIVE : DEPOSIT_ACCOUNT_STATE.UNINIT;

    }

    if (raw === "uninitialized" || raw === "uninit") {

        return DEPOSIT_ACCOUNT_STATE.UNINIT;

    }

    if (!raw && !hasCode) {

        return DEPOSIT_ACCOUNT_STATE.NONEXISTENT;

    }

    return DEPOSIT_ACCOUNT_STATE.UNINIT;

}

function parseCodeCell(code) {

    if (!code) {

        return null;

    }

    if (code instanceof Cell) {

        return code;

    }

    if (typeof code !== "string" || !code.trim()) {

        return null;

    }

    try {

        return Cell.fromBase64(code.trim());

    } catch {

        try {

            const cells = Cell.fromBoc(Buffer.from(code.trim(), "base64"));

            return cells[0] ?? null;

        } catch {

            return null;

        }

    }

}

function readIntFromGetResult(result, method) {

    if (result && typeof result.exit_code === "number" && result.exit_code !== 0) {

        throw new InvalidResponseError(
            `Deposit getter ${method} failed | exit_code=${result.exit_code}`
        );

    }

    const stack = result?.stack;

    if (stack && typeof stack.readBigNumber === "function") {

        try {

            return stack.readBigNumber();

        } catch (error) {

            throw new InvalidResponseError(
                `Deposit getter ${method} missing integer | ${error?.message ?? error}`
            );

        }

    }

    const item = Array.isArray(stack)
        ? stack[0]
        : (Array.isArray(stack?.items) ? stack.items[0] : null);

    if (item == null) {

        throw new InvalidResponseError(`Deposit getter ${method} returned empty stack`);

    }

    if (Array.isArray(item) && item.length >= 2) {

        return BigInt(item[1]);

    }

    const value = item?.value ?? item?.num ?? item;

    if (typeof value === "bigint") {

        return value;

    }

    if (typeof value === "number" && Number.isInteger(value)) {

        return BigInt(value);

    }

    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {

        return BigInt(value.trim());

    }

    throw new InvalidResponseError(`Deposit getter ${method} returned invalid integer`);

}

function inboundValueNano(tx) {

    const inMsg = tx?.in_msg ?? tx?.inMessage ?? null;
    const raw = inMsg?.value ?? inMsg?.amount ?? null;

    if (typeof raw === "bigint") {

        return raw;

    }

    if (typeof raw === "number" && Number.isInteger(raw)) {

        return BigInt(raw);

    }

    if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {

        return BigInt(raw.trim());

    }

    return null;

}

function transactionHashOf(tx) {

    const hash = tx?.transaction_id?.hash ?? tx?.txHash ?? tx?.hash ?? null;

    return typeof hash === "string" && hash.trim() ? hash.trim() : null;

}

function transactionLtOf(tx) {

    const lt = tx?.transaction_id?.lt ?? tx?.lt ?? null;

    return lt == null ? null : String(lt);

}

function inboundMessage(tx) {

    return tx?.in_msg ?? tx?.inMessage ?? null;

}

function isBouncedOrFailed(tx) {

    const inMsg = inboundMessage(tx);

    if (inMsg?.bounced === true) {

        return true;

    }

    return isFailedTonTransaction(tx);

}

function classifyPollError(error) {

    if (isInfrastructureFailure(error)
        || error instanceof NetworkUnavailableError
        || error instanceof TimeoutError) {

        return "transient";

    }

    if (error instanceof InvalidResponseError) {

        return "invalid_response";

    }

    if (error instanceof DepositBlockchainSourceError) {

        return error.details?.kind ?? "invalid_contract";

    }

    return "permanent";

}

export class RealTonDepositBlockchainSource {

    constructor({
        tonService = null,
        network = "testnet",
        logger = null,
        monitor = null,
        expectedArtifactSha256 = null,
        now = () => Date.now()
    } = {}) {

        if (!tonService) {

            throw new DepositBlockchainSourceError(
                "RealTonDepositBlockchainSource requires TonService"
            );

        }

        this._tonService = tonService;
        this._network = assertSupportedNetwork(network);
        this._logger = logger;
        this._monitor = monitor;
        this._expectedArtifactSha256 = expectedArtifactSha256;
        this._now = now;
        this._expectedCodeHash = null;
        this._cursors = new Map();

        this._assertReadOnlyTonService();

    }

    attachMonitor(monitor) {

        this._monitor = monitor;

    }

    /**
     * Poll active DepositMonitor watches. Never emits DEPOSIT_FULL.
     *
     * @param {Array<object>|null} watches
     */
    async poll(watches = null) {

        const list = Array.isArray(watches)
            ? watches
            : (this._monitor?.listActiveWatches?.() ?? []);

        const results = [];

        for (const watch of list) {

            results.push(await this.pollWatch(watch));

        }

        return Object.freeze({
            observed: results.reduce((sum, item) => sum + item.observations.length, 0),
            skipped: results.reduce((sum, item) => sum + item.skipped.length, 0),
            failed: results.filter((item) => item.ok === false).length,
            results: Object.freeze(results)
        });

    }

    async pollWatch(watch) {

        const empty = {
            ok: false,
            watch,
            observations: [],
            skipped: [],
            depositState: null,
            contractState: null,
            reason: null
        };

        try {

            this._assertNetwork(watch);

            const address = normalizeDepositWallet(watch?.depositAddress);

            if (!address) {

                return Object.freeze({
                    ...empty,
                    reason: "missing_deposit_address"
                });

            }

            const contractState = await this.getContractState(address);

            if (contractState.state === DEPOSIT_ACCOUNT_STATE.NONEXISTENT) {

                return Object.freeze({
                    ...empty,
                    contractState,
                    reason: "nonexistent_contract"
                });

            }

            if (contractState.state === DEPOSIT_ACCOUNT_STATE.UNINIT) {

                return Object.freeze({
                    ...empty,
                    contractState,
                    reason: "uninitialized_contract"
                });

            }

            if (contractState.state === DEPOSIT_ACCOUNT_STATE.FROZEN) {

                return Object.freeze({
                    ...empty,
                    contractState,
                    reason: "frozen_contract"
                });

            }

            if (!contractState.codeHash) {

                return Object.freeze({
                    ...empty,
                    contractState,
                    reason: "missing_code"
                });

            }

            const expectedCodeHash = this._loadExpectedCodeHash();

            if (contractState.codeHash !== expectedCodeHash) {

                return Object.freeze({
                    ...empty,
                    contractState,
                    reason: "code_hash_mismatch"
                });

            }

            const depositState = await this.getDepositState(address);

            if (Number(depositState.networkTag) !== expectedNetworkTag(this._network)) {

                return Object.freeze({
                    ...empty,
                    contractState,
                    depositState,
                    reason: "network_tag_mismatch"
                });

            }

            const transactions = await this.getTransactions(address);

            const observations = [];
            const skipped = [];

            for (const tx of transactions) {

                const decoded = this._decodeFundingTransaction(tx, watch);

                if (!decoded.ok) {

                    skipped.push(Object.freeze({
                        transactionHash: decoded.transactionHash,
                        reason: decoded.reason
                    }));

                    continue;

                }

                let observation = decoded.observation;

                if (this._monitor?.processObservation) {

                    try {

                        observation = this._monitor.processObservation(
                            decoded.observationInput
                        ) ?? observation;

                    } catch (error) {

                        skipped.push(Object.freeze({
                            transactionHash: decoded.transactionHash,
                            reason: "observation_error",
                            error: error?.message ?? String(error)
                        }));

                    }

                }

                observations.push(observation);

            }

            if (transactions.length > 0) {

                const newest = transactions[transactions.length - 1];

                this._cursors.set(watch.depositId, {
                    lt: transactionLtOf(newest),
                    hash: transactionHashOf(newest)
                });

            }

            return Object.freeze({
                ok: true,
                watch,
                observations: Object.freeze(observations),
                skipped: Object.freeze(skipped),
                depositState,
                contractState,
                reason: null
            });

        } catch (error) {

            const kind = classifyPollError(error);

            this._logWarn(
                `Deposit TON poll failed | kind=${kind} | `
                    + `depositId=${watch?.depositId ?? "unknown"} | `
                    + `message=${error?.message ?? error}`
            );

            return Object.freeze({
                ...empty,
                reason: kind === "transient" ? "rpc_unavailable" : kind,
                error: error?.message ?? String(error)
            });

        }

    }

    async getContractState(address) {

        const friendly = toFriendlyAddress(address);

        const info = await this._tonService.getAccount(friendly);

        const state = mapAccountState(info);
        const codeCell = parseCodeCell(info?.code);
        let codeHash = null;

        if (codeCell) {

            try {

                codeHash = codeCell.hash().toString("hex");

            } catch {

                throw new DepositBlockchainSourceError(
                    "Deposit contract code cannot be parsed",
                    { kind: "invalid_contract", address: friendly }
                );

            }

        }

        const balanceRaw = info?.balance ?? info?.balanceNano ?? null;
        let balanceNano = null;

        if (balanceRaw != null && /^-?\d+$/.test(String(balanceRaw))) {

            balanceNano = BigInt(String(balanceRaw));

        }

        return Object.freeze({
            address: friendly,
            state,
            codeHash,
            balanceNano,
            lastLt: info?.last_transaction_id?.lt ?? info?.lastTransactionId?.lt ?? null,
            lastHash: info?.last_transaction_id?.hash ?? info?.lastTransactionId?.hash ?? null
        });

    }

    /**
     * R17.9L.22 — Full getter snapshot for activation verification.
     * Read-only. Does not interpret balance as funding.
     */
    async readActivationGetters(address) {

        return readFullDepositGetters(this._tonService, toFriendlyAddress(address));

    }

    async getDepositState(address) {

        const friendly = toFriendlyAddress(address);

        const version = await this._runIntGetter(friendly, "get_version");
        const depositIdHash = await this._runIntGetter(friendly, "get_deposit_id");
        const roomIdHash = await this._runIntGetter(friendly, "get_room_id_hash");
        const gameIdHash = await this._runIntGetter(friendly, "get_game_id_hash");
        const paidMask = await this._runIntGetter(friendly, "get_paid_mask");
        const status = await this._runIntGetter(friendly, "get_status");
        const credited0 = await this._runIntGetter(friendly, "get_credited_amount0");
        const credited1 = await this._runIntGetter(friendly, "get_credited_amount1");
        const credited2 = await this._runIntGetter(friendly, "get_credited_amount2");
        const surplusNano = await this._runIntGetter(friendly, "get_surplus_nano");
        const expiresAt = await this._runIntGetter(friendly, "get_expires_at");
        const networkTag = await this._runIntGetter(friendly, "get_network_tag");

        return Object.freeze({
            address: friendly,
            contractVersion: version,
            depositIdHash,
            roomIdHash,
            gameIdHash,
            paidMask,
            status,
            creditedAmount0: credited0,
            creditedAmount1: credited1,
            creditedAmount2: credited2,
            surplusNano,
            expiresAt,
            networkTag
        });

    }

    async getTransactions(address, { limit = TX_PAGE_LIMIT } = {}) {

        const friendly = toFriendlyAddress(address);
        const query = {
            limit,
            archival: true
        };

        const transactions = await this._tonService.getTransactions(friendly, query);

        const ordered = [...transactions].sort((left, right) => {

            const leftLt = BigInt(transactionLtOf(left) ?? 0);
            const rightLt = BigInt(transactionLtOf(right) ?? 0);

            if (leftLt === rightLt) {

                return 0;

            }

            return leftLt < rightLt ? -1 : 1;

        });

        return Object.freeze(ordered);

    }

    buildObservation(input) {

        return DepositObservation.fromInput(input);

    }

    _decodeFundingTransaction(tx, watch) {

        const hash = transactionHashOf(tx);

        if (!hash) {

            return { ok: false, reason: "missing_transaction_hash", transactionHash: null };

        }

        if (isBouncedOrFailed(tx)) {

            return { ok: false, reason: "failed_or_bounced", transactionHash: hash };

        }

        const inMsg = inboundMessage(tx);

        if (!inMsg) {

            return { ok: false, reason: "missing_inbound_message", transactionHash: hash };

        }

        const body = inMsg.msg_data?.body ?? inMsg.body ?? null;
        const fundSeat = decodeFundSeatBody(body);

        if (!fundSeat) {

            return { ok: false, reason: "not_fund_seat", transactionHash: hash };

        }

        const sender = canonicalizeTonWalletAddress(
            inMsg.source ?? inMsg.sender ?? inMsg.from ?? ""
        );

        if (!sender) {

            return { ok: false, reason: "missing_sender", transactionHash: hash };

        }

        const valueNano = inboundValueNano(tx);

        if (valueNano == null || valueNano <= 0n) {

            return { ok: false, reason: "invalid_value", transactionHash: hash };

        }

        if (valueNano > BigInt(Number.MAX_SAFE_INTEGER)) {

            return { ok: false, reason: "value_overflow", transactionHash: hash };

        }

        const amount = Number(valueNano);
        const timestamp = Number(tx.utime ?? tx.now ?? 0) * 1000 || this._now();

        const observationInput = Object.freeze({
            depositId: watch.depositId,
            depositAddress: watch.depositAddress,
            transactionHash: hash,
            senderWallet: sender,
            amount,
            timestamp,
            network: this._network,
            seatIndex: fundSeat.seatIndex,
            lt: transactionLtOf(tx)
        });

        return {
            ok: true,
            transactionHash: hash,
            observationInput,
            observation: DepositObservation.fromInput(observationInput)
        };

    }

    async _runIntGetter(address, method) {

        const result = await this._tonService.runGetMethod(address, method, []);

        return readIntFromGetResult(result, method);

    }

    _loadExpectedCodeHash() {

        if (this._expectedCodeHash) {

            return this._expectedCodeHash;

        }

        assertVerifiedDepositArtifact({
            expectedSha256: this._expectedArtifactSha256 ?? null
        });

        const code = loadDepositCodeCell({
            expectedSha256: this._expectedArtifactSha256 ?? null
        });

        this._expectedCodeHash = code.hash().toString("hex");

        return this._expectedCodeHash;

    }

    _assertNetwork(watch) {

        const serviceNetwork = normalizeNetwork(this._tonService.getActiveNetwork?.());

        if (serviceNetwork && serviceNetwork !== this._network) {

            throw new DepositBlockchainSourceError(
                "TonService network does not match adapter network",
                {
                    kind: "network_mismatch",
                    adapterNetwork: this._network,
                    serviceNetwork
                }
            );

        }

        const watchNetwork = normalizeNetwork(watch?.network);

        if (watchNetwork && watchNetwork !== this._network) {

            throw new DepositBlockchainSourceError(
                "Watch network does not match adapter network",
                {
                    kind: "network_mismatch",
                    adapterNetwork: this._network,
                    watchNetwork
                }
            );

        }

    }

    _assertReadOnlyTonService() {

        const service = this._tonService;

        if (typeof service.getAccount !== "function"
            || typeof service.getTransactions !== "function"
            || typeof service.runGetMethod !== "function") {

            throw new DepositBlockchainSourceError(
                "TonService is missing required read methods"
            );

        }

    }

    _logWarn(message) {

        if (typeof this._logger?.warn === "function") {

            this._logger.warn(message);

        }

    }

}
