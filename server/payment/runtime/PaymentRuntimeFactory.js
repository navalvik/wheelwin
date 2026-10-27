/**
 * Room-wallet payment runtime composition root (Testnet).
 *
 * This factory is the SINGLE place that assembles the isolated Phase 1-4
 * payment core into a runnable server-side runtime. It is intentionally used
 * by BOTH the real application startup (`server/app.js`) and by tests, so the
 * two never drift: what the server runs is exactly what the tests exercise.
 *
 * Safety scope (unchanged from the isolated core):
 *   - Testnet only; global ID -3. Mainnet is rejected, never selected.
 *   - No smart contract / escrow / deposit system is referenced (R9).
 *   - No wallet secret material is read, retained or written. The wallet
 *     catalog is parsed through the existing secret-stripping loader and the
 *     outgoing signer path does not exist (payment execution is disabled).
 *   - This factory never moves real funds. Incoming observation is read-only;
 *     outgoing refunds have no authorized submitter, so live payment
 *     acceptance stays disabled and refunds remain recoverable obligations.
 *
 * Durable state (isolated per network namespace under `dataDir`) is file-backed
 * JSON with atomic temp+rename writes, matching the existing server storage
 * convention. Namespacing keeps Testnet and any future Mainnet stores fully
 * separate.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AssetDenominationRegistry } from "../AssetDenomination.js";
import { PaymentIntentStore } from "../PaymentIntentStore.js";
import { isPaymentIntentStoreContract } from "../PaymentIntentStoreContract.js";
import {
    DEFAULT_ROOM_WALLET_NETWORK,
    ROOM_LIFETIME_MS
} from "../RoomPaymentConstants.js";
import { RoomWalletPaymentService } from "../RoomWalletPaymentService.js";
import { RoomPreparationManifestStore } from "../RoomPreparationManifestStore.js";
import {
    resolveDefaultRoomWalletCatalogPath,
    WalletPoolRegistry
} from "../WalletPoolRegistry.js";
import { IncomingPaymentSettlementCoordinator } from "../incoming/IncomingPaymentSettlementCoordinator.js";
import {
    CurrencyMapping,
    LedgerStore,
    NANOTONS_PER_TON,
    RoomLedger
} from "../ledger/index.js";
import { RefundLifecycleCoordinator } from "../refund/RefundLifecycleCoordinator.js";
import { RefundObligationStore } from "../refund/RefundObligationStore.js";
import { REFUND_NETWORK } from "../refund/RefundObligation.js";
import { TestnetOutgoingRefundProvider } from "../refund/TestnetOutgoingRefundProvider.js";
import {
    RoomPaymentObservationService,
    ToncenterFinalityEvidenceProvider,
    ToncenterIncomingProvider,
    ToncenterTransactionsClient
} from "../toncenter/index.js";
import { RoomPaymentSessionAdapter } from "./RoomPaymentSessionAdapter.js";
import { LIVE_PAYMENT_ACCEPTANCE_ENABLED } from "../PaymentLifecycleAvailability.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** The only supported payment network in this runtime. */
export const SUPPORTED_PAYMENT_NETWORK = DEFAULT_ROOM_WALLET_NETWORK;

/** TON Testnet global chain ID (mainnet would be -239). */
export const TON_TESTNET_GLOBAL_ID = -3;

const CANONICAL_TON_ASSET = "TON";
const CANONICAL_TON_SYMBOL = "Gram";

/**
 * Default durable storage directory for the isolated room-wallet payment
 * runtime. Module-relative like the existing advertisement store, and never on
 * top of the retired historical financial volume.
 *
 * @returns {string}
 */
export function resolveDefaultRoomWalletPaymentDataDir() {

    return join(MODULE_DIR, "..", "..", "data", "room-wallet-payments");

}

/**
 * Enforce explicit network identity. A missing/unknown Mainnet request is a
 * hard failure: the runtime must never silently select or relabel a network.
 *
 * @param {string} network
 * @returns {{ network: string, globalId: number }}
 */
export function assertTestnetNetworkIdentity(network) {

    const normalized = typeof network === "string" ? network.trim().toLowerCase() : "";

    if (normalized !== SUPPORTED_PAYMENT_NETWORK) {

        throw new Error(
            "Room wallet payment runtime supports the TON Testnet (global ID -3) "
                + `only; requested network=${JSON.stringify(network)} is not selectable`
        );

    }

    return Object.freeze({ network: normalized, globalId: TON_TESTNET_GLOBAL_ID });

}

function validateNanoTonUnits(value, label) {

    if (!Number.isSafeInteger(value) || value <= 0) {

        throw new Error(`${label} must be a positive safe integer`);

    }

}

/**
 * Assemble the outgoing refund provider ONLY from an explicitly injected,
 * authorized, out-of-process Testnet signing mechanism (`refundSubmitter`).
 *
 * This factory NEVER constructs a signer and NEVER reads signing material.
 * When no complete signer+broadcaster+finality+observation bundle is injected
 * the provider is absent (returns null) and outgoing refunds stay disabled and
 * recoverable. Testnet identity is enforced before construction.
 *
 * @param {{ submitter: object|null, globalId: number, finalityEvidenceProvider: object|null }} deps
 * @returns {import("../refund/TestnetOutgoingRefundProvider.js").TestnetOutgoingRefundProvider|null}
 */
export function buildTestnetOutgoingRefundProvider({ submitter, globalId, finalityEvidenceProvider, walletPool = null }) {

    if (!submitter || globalId !== TON_TESTNET_GLOBAL_ID) {

        return null;

    }

    let provider;
    try {
        provider = new TestnetOutgoingRefundProvider({
            globalId,
            signer: submitter.signer ?? null,
            broadcaster: submitter.broadcaster ?? null,
            finalityEvidenceProvider: submitter.finalityEvidenceProvider ?? finalityEvidenceProvider ?? null,
            outgoingTransferProvider: submitter.outgoingTransferProvider ?? null,
            walletPool
        });
    } catch {
        // A non-Testnet or malformed bundle fails closed to "disabled".
        return null;
    }

    // Only a fully-capable Testnet provider is exposed; otherwise stay disabled.
    return provider.canExecute() ? provider : null;

}

/**
 * Assemble the payment runtime WITHOUT loading durable state. Call
 * `runtime.initialize()` to load stores and reconcile reservations, exactly as
 * the server lifecycle does.
 *
 * @param {{
 *   dataDir?: string,
 *   network?: string,
 *   walletCatalogPath?: string,
 *   nowProvider?: () => number,
 *   logger?: object|null,
 *   fetchImpl?: Function,
 *   apiKeyProvider?: Function,
 *   settlementEvidenceProvider?: object|null
 * }} [options]
 */
export function buildPaymentRuntime(options = {}) {

    const {
        dataDir = resolveDefaultRoomWalletPaymentDataDir(),
        network = SUPPORTED_PAYMENT_NETWORK,
        walletCatalogPath = resolveDefaultRoomWalletCatalogPath(),
        nowProvider = Date.now,
        logger = null,
        fetchImpl = globalThis.fetch,
        settlementEvidenceProvider = null,
        refundSubmitter = null,
        // Restored October settlement transport may be injected for offline
        // reconciliation/planning; never enables live payment acceptance.
        restoredSettlement = null,
        // Optional Testnet-only assembly after the authoritative wallet pool
        // exists. The factory is not a signer/submitter and cannot enable
        // payment acceptance or outgoing transfers.
        restoredSettlementFactory = null
    } = options;

    // R — network identity is enforced before any store or provider exists.
    const identity = assertTestnetNetworkIdentity(network);

    validateNanoTonUnits(NANOTONS_PER_TON, "NANOTONS_PER_TON");

    // Explicit per-network store namespace (Testnet vs future Mainnet).
    const networkDataDir = join(dataDir, identity.network);

    const walletPool = new WalletPoolRegistry({
        catalogPath: walletCatalogPath,
        network: identity.network,
        logger
    });

    if (restoredSettlementFactory !== null && typeof restoredSettlementFactory !== "function") {
        throw new Error("restored settlement factory must be a function");
    }
    const intentStore = new PaymentIntentStore({
        dataDir: networkDataDir,
        logger,
        nowProvider
    });

    if (!isPaymentIntentStoreContract(intentStore)) {

        throw new Error("payment intent store does not satisfy the store contract");

    }

    const assetRegistry = AssetDenominationRegistry.fromConfiguration({
        assets: [{
            asset: CANONICAL_TON_ASSET,
            symbol: CANONICAL_TON_SYMBOL,
            network: identity.network,
            atomicUnitsPerUnit: NANOTONS_PER_TON
        }]
    });

    // Test-only injection replaces the finality evidence provider; production
    // uses the real Toncenter finality verifier over the same read-only client.
    const client = new ToncenterTransactionsClient({
        fetchImpl,
        apiKeyProvider: options.apiKeyProvider
    });

    const evidenceProvider = settlementEvidenceProvider
        ?? new ToncenterFinalityEvidenceProvider({ client, nowProvider });

    const observationService = new RoomPaymentObservationService({
        provider: new ToncenterIncomingProvider({ client }),
        settlementEvidenceProvider: evidenceProvider,
        nowProvider
    });

    // Outgoing refund signer is NEVER constructed or read here. It is only
    // assembled when the caller injects an authorized, out-of-process Testnet
    // signing bundle; otherwise it is null and outgoing refunds stay disabled.
    const outgoingRefundProvider = buildTestnetOutgoingRefundProvider({
        submitter: refundSubmitter,
        globalId: identity.globalId,
        finalityEvidenceProvider: evidenceProvider,
        walletPool
    });

    const refundStore = new RefundObligationStore({
        dataDir: join(networkDataDir, "refunds"),
        logger
    });

    const paymentService = new RoomWalletPaymentService({
        walletPool,
        intentStore,
        assetRegistry,
        refundStore,
        observationService,
        snapshotDir: join(networkDataDir, "payment-core"),
        nowProvider,
        logger
    });

    const coordinator = new IncomingPaymentSettlementCoordinator({
        paymentService,
        observationService,
        logger,
        nowProvider
    });

    const ledgerStore = new LedgerStore({
        dataDir: networkDataDir,
        logger,
        nowProvider
    });

    const ledger = new RoomLedger({
        store: ledgerStore,
        currency: CurrencyMapping.nativeTon({ network: identity.network }),
        intentStore,
        logger
    });

    const manifestStore = new RoomPreparationManifestStore({
        dataDir: join(networkDataDir, "manifests")
    });

    const refundLifecycle = new RefundLifecycleCoordinator({
        store: refundStore,
        intentStore,
        ledgerStore,
        walletPool,
        nowProvider,
        logger,
        outgoingRefundProvider
    });

    const sessionAdapter = new RoomPaymentSessionAdapter({
        paymentService,
        coordinator,
        ledger,
        manifestStore,
        nowProvider
    });

    // The three-player game-start gate. Its shape matches exactly the
    // `getGameStartGateStatus(roomId, playerIds)` contract that
    // GameStartAuthorization enforces on every gameplay-start entry point.
    const paymentGate = Object.freeze({
        getGameStartGateStatus(roomId, playerIds) {

            return sessionAdapter.getGameStartGateStatus(roomId, playerIds);

        }
    });

    // Mutable initialization/recovery state kept outside the frozen descriptor.
    const state = { initialized: false, lastRecovery: null, restoredSettlement };

    const runtime = Object.freeze({
        // Durable stores + services.
        walletPool,
        intentStore,
        assetRegistry,
        paymentService,
        observationService,
        coordinator,
        ledger,
        ledgerStore,
        manifestStore,
        refundStore,
        refundLifecycle,
        outgoingRefundProvider,
        get restoredSettlement() { return state.restoredSettlement; },
        sessionAdapter,
        paymentGate,

        network: identity.network,
        globalId: identity.globalId,
        dataDir,
        networkDataDir,
        roomLifetimeMs: ROOM_LIFETIME_MS,
        _logger: logger,

        /**
         * Load durable state and reconcile wallet reservations, then recover
         * outstanding refund obligations. Idempotent: a second call on an
         * already-initialized runtime returns the prior recovery report.
         *
         * @param {{ providers?: Map<string, object> }} [options]
         * @returns {{ refundRecovery: Array<object> }}
         */
        initialize(options = {}) {

            if (state.initialized) {

                return Object.freeze({
                    refundRecovery: state.lastRecovery ?? Object.freeze([]),
                    replayed: true
                });

            }

            paymentService.initialize();

            // The catalog is loaded by paymentService.initialize(). A protected
            // resolver created earlier would see an EMPTY pool and silently
            // disable planning even when all 64 keys are configured.
            if (!state.restoredSettlement && restoredSettlementFactory) {
                try {
                    state.restoredSettlement = restoredSettlementFactory({
                        walletPool, network: identity.network, globalId: identity.globalId
                    }) ?? null;
                } catch {
                    // Planning is optional and never authorizes transfers.
                    logger?.warn?.("TESTNET_REFUND_PLANNER_UNAVAILABLE");
                }
            }

            ledger.initialize();

            manifestStore.initialize();

            // Refund recovery uses the identity-only Testnet provider. With no
            // authorized outgoing signer it reports each outstanding obligation
            // as PENDING_EXECUTION_DISABLED (recoverable, never fabricated).
            const providers = options.providers
                ?? new Map([[REFUND_NETWORK.TESTNET, outgoingRefundProvider ?? {
                    networkName: REFUND_NETWORK.TESTNET,
                    globalId: identity.globalId
                }]]);

            const refundRecovery = refundLifecycle.initialize({ providers });

            state.lastRecovery = refundRecovery;

            state.initialized = true;

            logger?.info?.(
                "RoomWalletPayment runtime ready"
                    + ` | network=${identity.network.toUpperCase()}`
                    + ` | globalId=${identity.globalId}`
                    + ` | wallets=${walletPool.size}`
                    + ` | intents=${intentStore.size}`
                    + ` | refundsPending=${refundStore.listPending().length}`
                    + ` | transfersEnabled=${Boolean(outgoingRefundProvider && outgoingRefundProvider.canExecute?.())}`
            );

            return Object.freeze({ refundRecovery, replayed: false });

        },

        /**
         * Read-only reconciliation preparation for a durable pending refund.
         * May prepare a signed fee-estimation BOC via the injected planner;\n         * never broadcasts or changes the refund ledger.
         */
        async planPendingRefund(obligationId) {
            if (!state.initialized) {
                throw new Error("payment runtime not initialized");
            }
            if (!state.restoredSettlement || typeof state.restoredSettlement.planDurableRefund !== "function") {
                throw new Error("restored room-wallet settlement is not attached");
            }
            const obligation = refundStore.get(obligationId);
            if (!obligation) {
                throw new Error("refund obligation not found");
            }
            // A failed or ambiguous prior submission must be reconciled,
            // never planned again as if it were a fresh refund.
            if (obligation.state !== "PENDING" ||
                obligation.networkName !== REFUND_NETWORK.TESTNET ||
                obligation.globalId !== identity.globalId) {
                throw new Error("refund obligation is not pending on TON Testnet");
            }
            return state.restoredSettlement.planDurableRefund(obligation);
        },

        get initialized() {

            return state.initialized === true;

        },

        /**
         * Explicit, auditable capability descriptor. Outgoing refund submission
         * is intentionally reported as disabled — the repository has no
         * authorized Testnet transfer signer, so this must not be faked.
         *
         * @returns {Readonly<object>}
         */
        getCapabilities() {

            return Object.freeze({
                network: identity.network,
                networkName: REFUND_NETWORK.TESTNET,
                globalId: identity.globalId,
                roomLifetimeMs: ROOM_LIFETIME_MS,
                incomingObservationEnabled: true,
                incomingFinalityVerificationEnabled: true,
                settlementEnabled: true,
                gameStartGateEnforced: true,
                outgoingRefundTransfersEnabled: Boolean(outgoingRefundProvider && outgoingRefundProvider.canExecute?.()),
                livePaymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED,
                outgoingRefundDisabledReason: Boolean(outgoingRefundProvider && outgoingRefundProvider.canExecute?.())
                    ? null
                    : "NO_AUTHORIZED_TESTNET_OUTGOING_SIGNER"
            });

        },

        /** Persist wallet reservations and mark the runtime uninitialized. */
        shutdown() {

            if (paymentService.persistSnapshot) {

                paymentService.persistSnapshot();

            }

            state.initialized = false;

        }
    });

    return runtime;

}
