import { FinancialOutcomeStore } from '../FinancialOutcomeStore.js';
import { IncomingReceiptStore } from '../incoming/IncomingReceiptStore.js';
import { IncomingReceiptAccounting } from '../incoming/IncomingReceiptAccounting.js';
import { PaymentForensicJournal } from "../PaymentForensicJournal.js";
import { recoverSettledPrincipal } from './recoverSettledPrincipal.js';
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
 *     signer capabilities are injected only by the explicit Testnet entrypoint.
 *   - Default acceptance is disabled. Explicitly configured Testnet workers
 *     execute durable debts and independently reconcile on-chain delivery.
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
import { countUnsettledRoomFinancialObligations } from "./countUnsettledRoomFinancialObligations.js";
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
 * runtime. Railway uses a new namespace inside its persistent mounted volume;
 * historical escrow records are never imported.
 *
 * @returns {string}
 */
export function resolveDefaultRoomWalletPaymentDataDir(env = process.env) {
    if (env.ROOM_WALLET_DATA_DIR) return env.ROOM_WALLET_DATA_DIR;
    if (env.RAILWAY_VOLUME_MOUNT_PATH) return join(env.RAILWAY_VOLUME_MOUNT_PATH, "room-wallet-payments");
    if (env.RAILWAY_ENVIRONMENT_ID) throw new Error("Persistent room-wallet volume is required on Railway");

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
export function buildTestnetOutgoingRefundProvider({ submitter, globalId, finalityEvidenceProvider }) {

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
            outgoingTransferProvider: submitter.outgoingTransferProvider ?? null
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
        refundSubmitterFactory = null
    } = options;

    // R — network identity is enforced before any store or provider exists.
    const identity = assertTestnetNetworkIdentity(network);

    validateNanoTonUnits(NANOTONS_PER_TON, "NANOTONS_PER_TON");

    // Explicit per-network store namespace (Testnet vs future Mainnet).
    const networkDataDir = join(dataDir, identity.network);

    const outcomeStore = new FinancialOutcomeStore(networkDataDir);
    const walletPool = new WalletPoolRegistry({
        catalogPath: walletCatalogPath,
        network: identity.network,
        logger
    });

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
    // Real native signing is supplied only when the entrypoint explicitly
    // opts in. The factory is never called on the disabled acceptance path.
    // Runtime constructs neither secrets nor a signer on its own.
    if (refundSubmitter !== null && refundSubmitterFactory !== null) {
        throw new Error("REFUND_SIGNER_CONFIGURATION_CONFLICT");
    }
    if (refundSubmitterFactory !== null
        && typeof refundSubmitterFactory !== "function") {
        throw new TypeError("refundSubmitterFactory must be a function");
    }
    const nativeRefundSubmitter = refundSubmitterFactory === null
        ? refundSubmitter
        : refundSubmitterFactory(Object.freeze({
            walletPool,networkDataDir,network:identity.network,
            globalId:identity.globalId
        }));
    const outgoingRefundProvider = buildTestnetOutgoingRefundProvider({
        submitter: nativeRefundSubmitter,
        globalId: identity.globalId,
        finalityEvidenceProvider: evidenceProvider
    });

    // The public room-wallet registry must account for outstanding prize
    // and refund debts, not merely PENDING/MATCHED incoming intents. The
    // callback is evaluated only after both durable financial stores load.
    let ledger = null;
    let refundStore = null;
    const receiptStore = new IncomingReceiptStore({ dataDir: networkDataDir });
    const paymentForensicJournal = new PaymentForensicJournal({ dataDir: networkDataDir });
    let receiptAccounting = null;
    const financialObligationCountProvider = roomId =>
        countUnsettledRoomFinancialObligations({roomId,ledger,refundStore,receiptStore});

    const paymentService = new RoomWalletPaymentService({
        financialObligationCountProvider,
        walletPool,
        intentStore,
        assetRegistry,
        observationService,
        snapshotDir: join(networkDataDir, "payment-core"),
        nowProvider,
        logger
    });

    const coordinator = new IncomingPaymentSettlementCoordinator({
        receiptAccounting: { capture: observation => receiptAccounting.capture(observation) },
        auditJournal: paymentForensicJournal,
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

    ledger = new RoomLedger({
        store: ledgerStore,
        currency: CurrencyMapping.nativeTon({ network: identity.network }),
        intentStore,
        logger
    });

    const manifestStore = new RoomPreparationManifestStore({
        dataDir: join(networkDataDir, "manifests")
    });

    refundStore = new RefundObligationStore({
        dataDir: join(networkDataDir, "refunds"),
        logger
    });
    receiptAccounting = new IncomingReceiptAccounting({store: receiptStore, intentStore, refundStore, nowProvider});

    const refundLifecycle = new RefundLifecycleCoordinator({
        store: refundStore,
        outcomeStore,
        intentStore,
        ledgerStore,
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
    const state = { initialized: false, lastRecovery: null };

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
        receiptStore,
        paymentForensicJournal,
        receiptAccounting,
        outcomeStore,
        refundLifecycle,
        outgoingRefundProvider,
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

            // Recover prize/refund debts BEFORE reconciling wallet ownership.
            // Otherwise three SETTLED entry intents appear "closed" and the
            // pool may release a wallet still owing winners or players.
            ledger.initialize();
            refundStore.initialize();
            receiptStore.initialize();
            paymentForensicJournal.initialize();
            intentStore.initialize();

            manifestStore.initialize();
            // SETTLED intent is the authoritative durable receipt. Repair a crash
            // between writing that receipt and appending its principal entry.
            recoverSettledPrincipal({intentStore, ledgerStore, ledger});

            paymentService.initialize();

            // Refund recovery uses the identity-only Testnet provider. With no
            // authorized outgoing signer it reports each outstanding obligation
            // as PENDING_EXECUTION_DISABLED (recoverable, never fabricated).
            const providers = options.providers
                ?? new Map([[REFUND_NETWORK.TESTNET, outgoingRefundProvider ?? {
                    networkName: REFUND_NETWORK.TESTNET,
                    globalId: identity.globalId
                }]]);

            const refundRecovery = refundLifecycle.initialize({ providers });
            for (const closed of refundStore.listClosedRooms()) receiptAccounting.prepareClosedRoom(closed.roomId);

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

        financialSnapshot(roomId) {
            // Public financial records only; never export wallet catalog/signing material.
            return {schemaVersion:1, network:identity.network, globalId:identity.globalId, roomId,
                closedRoom:refundStore.getClosedRoom(roomId), outcome:outcomeStore.get(roomId),
                intents:intentStore.listForRoom(roomId).map(x => x.toRecord()),
                ledger:ledgerStore.listForRoom(roomId),
                receipts:receiptStore.listForRoom(roomId),
                refunds:refundStore.list().filter(x => x.roomId === roomId).map(x => x.toRecord()),
                paymentObservations:paymentForensicJournal.list(roomId, "observations"),
                paymentDecisions:paymentForensicJournal.list(roomId, "decisions"),
                outstandingObligations:financialObligationCountProvider(roomId)};
        },
        get initialized() {

            return state.initialized === true;

        },

        /**
         * Explicit, auditable capability descriptor. Transfer execution only
         * activates under the explicit Testnet opt-in with a complete provider.
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
                livePaymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED && Boolean(outgoingRefundProvider?.canExecute()),
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
