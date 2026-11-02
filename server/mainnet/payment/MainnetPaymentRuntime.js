import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MainnetFinancialLedger } from "./MainnetFinancialLedger.js";
import { MainnetIncomingPaymentLedger } from "./MainnetIncomingPaymentLedger.js";
import { MainnetIncomingPaymentService } from "./MainnetIncomingPaymentService.js";
import { MainnetPayoutLifecycle } from "./MainnetPayoutLifecycle.js";
import { MainnetRefundLifecycle } from "./MainnetRefundLifecycle.js";
import { MainnetPendingRefundExecutor } from "./MainnetPendingRefundExecutor.js";
import { MainnetPendingPayoutExecutor } from "./MainnetPendingPayoutExecutor.js";
import { MainnetTonapiPayoutVerifier } from "./MainnetTonapiPayoutVerifier.js";
import { MainnetToncenterOutgoingTransferObserver } from "./MainnetToncenterOutgoingTransferObserver.js";
import { MainnetToncenterReadClient } from "./MainnetToncenterReadClient.js";
import { MainnetGameStartPaymentGate } from "./MainnetGameStartPaymentGate.js";
import { createMainnetForensicFinancialSnapshot } from "./MainnetForensicFinancialSnapshot.js";
import { createMainnetWalletV4Transport } from "./MainnetWalletV4Transport.js";

const DISABLED_ADAPTER = Object.freeze({
    async estimateOutboundTransferFee() { throw new Error("MAINNET_LIVE_FINANCIAL_OPERATIONS_DISABLED"); },
    async sendTransfer() { throw new Error("MAINNET_LIVE_FINANCIAL_OPERATIONS_DISABLED"); }
});

/** Mainnet-only stores and lifecycle composition; live sends are disabled by default. */
export class MainnetPaymentRuntime {
    constructor({ config, env = process.env, client = null, walletV4Client = null,
        fetchImpl = globalThis.fetch, adapter = null, nowProvider = Date.now,
        independentVerifier = null, walletPool = null } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== -239
            || typeof nowProvider !== "function") {
            throw new Error("MAINNET_PAYMENT_RUNTIME_CONFIG_INVALID");
        }
        const liveOperationsRequested = env?.TON_NETWORK === "mainnet"
            && env?.ROOM_WALLET_PAYMENTS_ENABLED === "true";
        // An explicitly injected adapter is retained for offline harnesses.
        // Production bootstraps do not inject one, so permission opt-in is the
        // sole path to construction of the real Mainnet Wallet V4 transport.
        const activeAdapter = liveOperationsRequested
            ? (adapter ?? createMainnetWalletV4Transport({
                config, env, client: walletV4Client
            }))
            : (adapter ?? DISABLED_ADAPTER);
        if (typeof activeAdapter?.sendTransfer !== "function"
            || typeof activeAdapter?.estimateOutboundTransferFee !== "function") {
            throw new Error("MAINNET_PAYMENT_RUNTIME_ADAPTER_INVALID");
        }
        this.network = "mainnet";
        this.globalId = -239;
        this.liveOperationsEnabled = liveOperationsRequested;
        this.outgoingAdapter = activeAdapter;
        this.stateDirectories = Object.freeze({
            incoming: join(config.dataDir, "incoming-payment-ledger"),
            financial: join(config.dataDir, "financial-lifecycle"),
            outgoing: join(config.dataDir, "outgoing-seqno"),
            gameplay: join(config.dataDir, "gameplay-recovery")
        });
        for (const directory of Object.values(this.stateDirectories)) mkdirSync(directory, { recursive: true });
        this.client = client ?? new MainnetToncenterReadClient({ config, fetchImpl });
        this.incomingLedger = new MainnetIncomingPaymentLedger({ config, nowProvider }).initialize();
        this.financialLedger = new MainnetFinancialLedger({ config, nowProvider }).initialize();
        this.incomingPayments = new MainnetIncomingPaymentService({
            config, client: this.client, ledger: this.incomingLedger, nowProvider
        });
        this.gameStartPaymentGate = new MainnetGameStartPaymentGate({
            incomingLedger: this.incomingLedger
        });
        this.outgoingObserver = new MainnetToncenterOutgoingTransferObserver({
            client: this.client, nowProvider
        });
        this.independentVerifier = independentVerifier ?? new MainnetTonapiPayoutVerifier({
            apiKeyProvider: () => ""
        });
        this.refundLifecycle = new MainnetRefundLifecycle({
            financialLedger: this.financialLedger, incomingLedger: this.incomingLedger,
            adapter: activeAdapter, outgoingObserver: this.outgoingObserver,
            independentVerifier: this.independentVerifier, nowProvider
        });
        this.pendingRefundExecutor = new MainnetPendingRefundExecutor({ paymentRuntime: this });
        this.payoutLifecycle = new MainnetPayoutLifecycle({
            financialLedger: this.financialLedger, adapter: activeAdapter, outgoingObserver: this.outgoingObserver,
            independentVerifier: this.independentVerifier, nowProvider
        });
        this.pendingPayoutExecutor = walletPool
            ? new MainnetPendingPayoutExecutor({ paymentRuntime: this, walletPool }) : null;
    }

    initialize() { return this; }

    financialSnapshot(roomId) {
        return createMainnetForensicFinancialSnapshot({
            roomId,
            incomingLedger: this.incomingLedger,
            financialLedger: this.financialLedger
        });
    }
}
