/**
 * R18 — Requester-scoped Deposit projection for client delivery.
 *
 * This is an OUTBOUND INFORMATION DELIVERY boundary only. It reads
 * authoritative server state and MUST NOT:
 *  - create, mutate, or persist any financial state;
 *  - start a transaction or deploy anything;
 *  - call GameContractManager or DeploymentAuthorization;
 *  - move financial authority to the client.
 *
 * Authoritative sources:
 *  - DepositSession (via DepositSessionCoordinator) — phase, amounts, bindings
 *  - RoomLobbyBridge._roomCreators — creator identity
 *
 * The resulting projection carries ZERO authorization semantics: possession of
 * this data never triggers game-contract deployment (GAP-B is separate).
 */

import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";

/**
 * States at which the DepositContract has already been created on-chain.
 * Once the contract exists the creator no longer needs the frozen package.
 */
const POST_DEPLOYMENT_STATES = new Set([
    DEPOSIT_SESSION_STATUS.GAME_CONTRACT_CREATED,
    DEPOSIT_SESSION_STATUS.RELEASED,
    DEPOSIT_SESSION_STATUS.REIMBURSED
]);

/**
 * Terminal states where deployment will never occur and the package is
 * no longer actionable.
 */
const TERMINAL_NO_DEPLOY = new Set([
    DEPOSIT_SESSION_STATUS.EXPIRED,
    DEPOSIT_SESSION_STATUS.REFUNDING,
    DEPOSIT_SESSION_STATUS.REFUNDED
]);

/**
 * Determine whether the frozen package is still relevant for the requester.
 * The package is needed only while the Room Creator has not yet deployed the
 * DepositContract — i.e. while NO seat has observed funding (a FundSeat
 * observation implies the contract exists on-chain) and the session has not
 * reached a post-deployment or terminal lifecycle phase. Derived exclusively
 * from existing authoritative session state; never mutated here.
 */
function shouldExposePackage(depositSession) {

    if (!depositSession || typeof depositSession !== "object") {

        return false;
    }

    const sessionState = depositSession.state;

    if (POST_DEPLOYMENT_STATES.has(sessionState)
        || TERMINAL_NO_DEPLOY.has(sessionState)) {

        return false;
    }

    // GameContract creation recorded by the authoritative lifecycle.
    if (depositSession.gameContractCreatedAt != null) {

        return false;
    }

    // Any observed FundSeat proves the DepositContract exists on-chain;
    // the creator no longer needs (and must not re-receive) the package.
    const bindings = Array.isArray(depositSession.bindings)
        ? depositSession.bindings
        : [];

    if (bindings.some((binding) => binding?.funded === true)) {

        return false;
    }

    return true;
}

/**
 * Resolve the authoritative network from the frozen deposit package or session
 * metadata. Never fabricates a value — returns null when unavailable.
 */
function resolveNetwork(session) {

    const pkg = session?.metadata?.depositPackage;
    if (pkg?.network) {

        return String(pkg.network);
    }

    if (session?.metadata?.network) {

        return String(session.metadata.network);
    }

    if (session?.metadata?.tonNetwork) {

        return String(session.metadata.tonNetwork);
    }

    return null;
}

/**
 * Count funded seats. Coarse 0..3 aggregate only — never exposes individual
 * player amounts or wallets.
 */
function countConfirmedSeats(bindings) {

    if (!Array.isArray(bindings)) {

        return 0;
    }

    return bindings.filter((binding) => binding?.funded === true).length;
}

/**
 * Convert a BigInt or Number expected amount to a plain Number, or null.
 */
function toNanotonNumber(value) {

    if (value == null) {

        return null;
    }

    if (typeof value === "bigint") {

        return Number(value);
    }

    const n = Number(value);

    return Number.isFinite(n) ? n : null;
}

/**
 * Map session binding `funded` into the client-facing seat-status vocabulary.
 * Minimum semantic distinction: PENDING | FUNDED.
 */
function mapSeatStatus(funded) {

    return funded === true ? "FUNDED" : "PENDING";
}

/**
 * Build the minimal client-facing package projection from the frozen
 * authoritative package. Only exposes stateInit cells and the deploy value.
 * Never recomputes or regenerates the StateInit.
 */
function projectPackage(depositPackage) {

    if (!depositPackage || typeof depositPackage !== "object") {

        return null;
    }

    const stateInit = depositPackage.stateInit;
    const codeBoc = stateInit?.codeBoc ?? null;
    const dataBoc = stateInit?.dataBoc ?? null;

    if (!codeBoc || !dataBoc) {

        return null;
    }

    // deployValueNanotons is exposed ONLY if the frozen package itself
    // carries it. The frozen package does not embed a deploy value today
    // (creation fees live inside each binding's expectedAmount); we never
    // substitute or recalculate another field into it.
    const deployValueNanotons = depositPackage.deployValueNanotons != null
        ? Number(depositPackage.deployValueNanotons)
        : null;

    return Object.freeze({
        stateInit: Object.freeze({
            codeBoc,
            dataBoc
        }),
        deployValueNanotons
    });
}

/**
 * Read the authoritative creator identity for a room from
 * RoomLobbyBridge._roomCreators.
 */
function readCreatorId(roomLobbyBridge, roomId) {

    const map = roomLobbyBridge?._roomCreators;
    if (!map || typeof map.get !== "function") {

        return null;
    }

    return map.get(roomId) ?? null;
}

/**
 * Produce a requester-scoped Deposit projection.
 *
 * @param {object} opts
 * @param {string} opts.playerId — the requesting player (identity).
 * @param {string} opts.roomId — authoritative room identity.
 * @param {string} opts.gameId — authoritative game identity.
 * @param {object|null} opts.session — pre-resolved DepositSession (optional;
 *   if omitted the coordinator is queried).
 * @param {object|null} opts.depositSessionCoordinator — authoritative
 *   DepositSession source (DepositSessionCoordinator instance).
 * @param {object|null} opts.roomLobbyBridge — authoritative creator source
 *   (RoomLobbyBridge instance with `_roomCreators`).
 * @param {object|null} [opts.logger] — optional diagnostic logger; used ONLY
 *   to report consistency conflicts (existing logging conventions).
 * @returns {object|null} requester-scoped projection, or null when no
 *   authoritative session can be resolved (fail-closed).
 */
export function projectDepositForPlayer({
    playerId = null,
    roomId = null,
    gameId = null,
    session = null,
    depositSessionCoordinator = null,
    roomLobbyBridge = null,
    logger = null
} = {}) {

    if (!playerId || !roomId || !gameId) {

        return null;
    }

    // --- Resolve the authoritative live DepositSession ---
    // In-memory after creation; survives restart via restoreActiveSessions().
    let depositSession = session;

    if (!depositSession && depositSessionCoordinator) {

        depositSession = depositSessionCoordinator.getByRoomAndGame?.(
            roomId,
            gameId
        ) ?? null;

    }

    if (!depositSession) {

        // No authoritative session → fail closed (no projection delivered).
        return null;

    }

    // --- isCreator: authoritative creator identity from RoomLobbyBridge ---
    let creatorId = null;
    if (roomLobbyBridge) {

        try {
            creatorId = readCreatorId(roomLobbyBridge, roomId);
        } catch {
            creatorId = null;
        }
    }

    const isCreator = creatorId == null ? null : (creatorId === playerId);

    // --- mySeatIndex: authoritative admission order via binding index ---
    // bindings are stored in player-admission order (creator bound first).
    const bindings = Array.isArray(depositSession.bindings)
        ? depositSession.bindings
        : [];

    const seatIndex = bindings.findIndex(
        (binding) => binding?.playerId === playerId
    );

    const confirmedSeats = countConfirmedSeats(bindings);
    const network = resolveNetwork(depositSession);
    const phase = depositSession.state ?? null;
    const depositId = depositSession.depositId ?? null;
    const depositAddress = depositSession.depositAddress ?? null;

    // --- Package: only while the creator still needs to deploy ---
    let pkg = null;
    if (shouldExposePackage(depositSession)) {

        const frozen = depositSession?.metadata?.depositPackage;
        if (frozen) {
            pkg = projectPackage(frozen);
        }
    }

    // R18 §9 — Creator / Seat-0 consistency. The creator occupies the first
    // admitted position. Both values were derived independently above; a
    // contradiction between two AVAILABLE values is corrupt state and MUST
    // fail closed without normalization. Absence of creator identity (e.g.
    // after a server restart, _roomCreators being in-memory-only) is NOT a
    // conflict: it degrades to isCreator=null while seat data stays intact.
    const conflict =
        (isCreator === true && seatIndex !== 0)
        || (isCreator === false && seatIndex === 0);

    if (conflict) {

        logger?.error?.(
            "[R18] Deposit projection conflict"
            + ` | roomId=${roomId}`
            + ` | playerId=${playerId}`
            + ` | depositId=${depositId ?? "null"}`
            + ` | isCreator=${String(isCreator)}`
            + ` | mySeatIndex=${seatIndex}`
        );
    }

    if (conflict || seatIndex < 0) {

        // Fail closed — no seat identity, no financial authorization data.
        return Object.freeze({
            phase,
            depositId,
            depositAddress,
            network,
            ...(pkg ? { package: pkg } : {}),
            mySeatIndex: null,
            isCreator: null,
            mySeatStatus: "PENDING",
            myExpectedAmountNanotons: null,
            confirmedSeats
        });
    }

    const seat = bindings[seatIndex];

    return Object.freeze({
        phase,
        depositId,
        depositAddress,
        network,
        ...(pkg ? { package: pkg } : {}),
        mySeatIndex: seatIndex,
        isCreator,
        mySeatStatus: mapSeatStatus(seat?.funded),
        myExpectedAmountNanotons: toNanotonNumber(seat?.expectedAmount),
        confirmedSeats
    });
}
