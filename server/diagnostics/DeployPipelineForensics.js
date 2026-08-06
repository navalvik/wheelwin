/**
 * R7.11B — Temporary deploy-pipeline forensics (diagnostics only).
 * Shared stage timestamps so each log can report duration since previous stage.
 * R7.51.29 — TON_DEPLOY_DEBUG last-attempt snapshot for Developer Console.
 */

const _lastStageAtByRoom = new Map();
const _attemptByRoom = new Map();

/** @type {null | {
 *   timestamp: number,
 *   roomId: string|null,
 *   gameId: string|null,
 *   deployStarted: boolean,
 *   deployerAddress: string|null,
 *   deployerWalletId: number|null,
 *   seqno: number|null,
 *   escrowAddress: string|null,
 *   valueTon: string|null,
 *   stage: string[],
 *   errorName: string|null,
 *   errorMessage: string|null
 * }} */
let _tonDeployDebug = null;

/** @type {null | {
 *   mode: string|null,
 *   contractAddress: string|null,
 *   codeHash: string|null,
 *   dataHash: string|null,
 *   oracle: string|null,
 *   owner: string|null,
 *   transactionHash: string|null,
 *   valueTon: string|null,
 *   snapshotHash: string|null
 * }} */
let _gameEscrowDeployDebug = null;

/**
 * @param {string} roomId
 * @returns {number}
 */
export function nextDeployAttempt(roomId) {

    const key = String(roomId ?? "");
    const next = (_attemptByRoom.get(key) ?? 0) + 1;

    _attemptByRoom.set(key, next);

    return next;

}

/**
 * @param {string} roomId
 * @param {string} stage
 * @returns {{ now: number, elapsedMs: number|null }}
 */
export function markDeployStage(roomId, stage) {

    const key = String(roomId ?? "");
    const now = Date.now();
    const previous = _lastStageAtByRoom.get(key);
    const elapsedMs = previous ? now - previous.at : null;

    _lastStageAtByRoom.set(key, { at: now, stage });

    return { now, elapsedMs };

}

/**
 * @param {string} roomId
 * @returns {{ stage: string, at: number } | null}
 */
export function getLastDeployStage(roomId) {

    const key = String(roomId ?? "");

    return _lastStageAtByRoom.get(key) ?? null;

}

/**
 * R7.51.29 — Start a new TON deploy diagnostic attempt (no secrets).
 *
 * @param {{
 *   roomId?: string|null,
 *   gameId?: string|null,
 *   escrowAddress?: string|null,
 *   valueTon?: string|null
 * }} [fields]
 */
export function beginTonDeployDebug(fields = {}) {

    _tonDeployDebug = {
        timestamp: Date.now(),
        roomId: fields.roomId ?? null,
        gameId: fields.gameId ?? null,
        deployStarted: true,
        deployerAddress: null,
        deployerWalletId: null,
        seqno: null,
        escrowAddress: fields.escrowAddress ?? null,
        valueTon: fields.valueTon ?? null,
        stage: ["START"],
        errorName: null,
        errorMessage: null,
        tonCenterStatus: null,
        tonCenterResponse: null,
        tonCenterEndpoint: null
    };

    // New deploy attempt clears prior GameEscrow deploy diagnostics.
    _gameEscrowDeployDebug = null;

    return getTonDeployDebug();

}

/**
 * R7.66E — TON_GAME_ESCROW_DEPLOY_DEBUG snapshot (no secrets).
 *
 * @param {{
 *   mode?: string|null,
 *   contractAddress?: string|null,
 *   codeHash?: string|null,
 *   dataHash?: string|null,
 *   oracle?: string|null,
 *   owner?: string|null,
 *   transactionHash?: string|null,
 *   valueTon?: string|null,
 *   snapshotHash?: string|null
 * }} [fields]
 */
export function setGameEscrowDeployDebug(fields = {}) {

    _gameEscrowDeployDebug = {
        mode: fields.mode ?? _gameEscrowDeployDebug?.mode ?? null,
        contractAddress: fields.contractAddress
            ?? _gameEscrowDeployDebug?.contractAddress
            ?? null,
        codeHash: fields.codeHash ?? _gameEscrowDeployDebug?.codeHash ?? null,
        dataHash: fields.dataHash ?? _gameEscrowDeployDebug?.dataHash ?? null,
        oracle: fields.oracle ?? _gameEscrowDeployDebug?.oracle ?? null,
        owner: fields.owner ?? _gameEscrowDeployDebug?.owner ?? null,
        transactionHash: fields.transactionHash
            ?? _gameEscrowDeployDebug?.transactionHash
            ?? null,
        valueTon: fields.valueTon ?? _gameEscrowDeployDebug?.valueTon ?? null,
        snapshotHash: fields.snapshotHash
            ?? _gameEscrowDeployDebug?.snapshotHash
            ?? null
    };

    return getGameEscrowDeployDebug();

}

/**
 * @returns {object|null}
 */
export function getGameEscrowDeployDebug() {

    if (!_gameEscrowDeployDebug) {

        return null;

    }

    return Object.freeze({ ..._gameEscrowDeployDebug });

}

/**
 * Print TON_GAME_ESCROW_DEPLOY_DEBUG block to stdout (Railway-visible).
 */
export function printGameEscrowDeployDebug(fields = null) {

    const snapshot = fields
        ? Object.freeze({ ...fields })
        : getGameEscrowDeployDebug();

    if (!snapshot) {

        return;

    }

    printDeployBlock("TON_GAME_ESCROW_DEPLOY_DEBUG", {
        mode: snapshot.mode,
        contractAddress: snapshot.contractAddress,
        codeHash: snapshot.codeHash,
        dataHash: snapshot.dataHash,
        oracle: snapshot.oracle,
        owner: snapshot.owner,
        transactionHash: snapshot.transactionHash,
        valueTon: snapshot.valueTon ?? null,
        snapshotHash: snapshot.snapshotHash ?? null
    });

}

/**
 * Append a stage marker and optional public diagnostic fields.
 * Never accepts mnemonic / secretKey / private keys.
 *
 * @param {string} stage
 * @param {Record<string, unknown>} [fields]
 */
export function pushTonDeployDebugStage(stage, fields = {}) {

    if (!_tonDeployDebug) {

        beginTonDeployDebug({});

    }

    if (stage) {

        _tonDeployDebug.stage.push(stage);

    }

    const allowed = [
        "roomId",
        "gameId",
        "deployerAddress",
        "deployerWalletId",
        "seqno",
        "escrowAddress",
        "valueTon",
        "errorName",
        "errorMessage",
        "tonCenterStatus",
        "tonCenterResponse",
        "tonCenterEndpoint"
    ];

    for (const key of allowed) {

        if (Object.prototype.hasOwnProperty.call(fields, key)) {

            _tonDeployDebug[key] = fields[key];

        }

    }

    _tonDeployDebug.timestamp = Date.now();

    return getTonDeployDebug();

}

/**
 * @returns {object|null}
 */
export function getTonDeployDebug() {

    if (!_tonDeployDebug) {

        return null;

    }

    return Object.freeze({
        timestamp: _tonDeployDebug.timestamp,
        roomId: _tonDeployDebug.roomId,
        gameId: _tonDeployDebug.gameId,
        deployStarted: _tonDeployDebug.deployStarted === true,
        deployerAddress: _tonDeployDebug.deployerAddress,
        deployerWalletId: _tonDeployDebug.deployerWalletId,
        seqno: _tonDeployDebug.seqno,
        escrowAddress: _tonDeployDebug.escrowAddress,
        valueTon: _tonDeployDebug.valueTon,
        stage: Object.freeze([..._tonDeployDebug.stage]),
        currentStage: _tonDeployDebug.stage[_tonDeployDebug.stage.length - 1]
            ?? null,
        errorName: _tonDeployDebug.errorName,
        errorMessage: _tonDeployDebug.errorMessage,
        tonCenterStatus: _tonDeployDebug.tonCenterStatus,
        tonCenterResponse: _tonDeployDebug.tonCenterResponse,
        tonCenterEndpoint: _tonDeployDebug.tonCenterEndpoint,
        // R7.66E — nested GameEscrow deploy diagnostics for lifecycle archive.
        gameEscrowDeploy: getGameEscrowDeployDebug()
    });

}

export function resetTonDeployDebugForTests() {

    _tonDeployDebug = null;

    _gameEscrowDeployDebug = null;

    _lastStageAtByRoom.clear();

    _attemptByRoom.clear();

}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export function safeSerialize(value, depth = 0) {

    if (value === null) {

        return "null";

    }

    if (value === undefined) {

        return "undefined";

    }

    if (depth > 4) {

        return "[MaxDepth]";

    }

    try {

        return JSON.stringify(value, (_key, nested) => {

            if (typeof nested === "bigint") {

                return String(nested);

            }

            if (nested instanceof Error) {

                return {
                    name: nested.name,
                    message: nested.message,
                    stack: nested.stack
                };

            }

            if (typeof nested === "function") {

                return `[Function ${nested.name || "anonymous"}]`;

            }

            return nested;

        }, 2);

    } catch (error) {

        return `[Unserializable: ${error?.message ?? error}]`;

    }

}

/**
 * @param {string} title
 * @param {Record<string, unknown>} fields
 */
export function printDeployBlock(title, fields) {

    console.log("======================================================");
    console.log(title);
    console.log("======================================================");

    for (const [key, value] of Object.entries(fields)) {

        if (value !== null && typeof value === "object") {

            console.log(`${key}:`, safeSerialize(value));

        } else {

            console.log(`${key}:`, value);

        }

    }

    console.log("======================================================");

}
