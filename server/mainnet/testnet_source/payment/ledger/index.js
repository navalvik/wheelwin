/**
 * Phase 4 — Server-authoritative internal ledger + payout accounting (isolated).
 *
 * This module keeps a native-TON internal ledger (integer atomic units only)
 * and computes validated payout plans. It is deliberately self-contained and
 * built ON TOP of the isolated Phase 1–3 modules:
 *
 *   - native TON only; no custom financial contract of any kind (no escrow,
 *     deposit, settlement, payout, refund or payment-authorization contract)
 *     and no restored historical financial code;
 *   - no transaction execution, broadcast, retry, or wallet signing;
 *   - no provider access (Phase 4 never queries any provider, node or
 *     endpoint, and never estimates fees itself);
 *   - no wallet secrets are ever read, retained, moved or written;
 *   - the internal ledger is NOT connected to application startup or live
 *     payment collection in this phase — it is accounting and payout planning.
 *
 * Approved payout rule (Phase 4 alignment) — the FIXED 95% winner rule:
 *
 *   winnerGrossAllocationAtomic  = floor(totalSettledPrincipalAtomic * 95 / 100)
 *   ownerGrossAllocationAtomic   = totalSettledPrincipalAtomic
 *                                  - winnerGrossAllocationAtomic
 *   gasReserveAtomic             = principal - winner - owner (retained)
 *
 * The winner receives 95% of the total settled principal, rounded down to a
 * whole nanoton; the owner receives the exact remainder (including any
 * rounding remainder). The 95% share is a FIXED, immutable business-rule
 * constant (see `PayoutAllocationConfig` / `WINNER_SHARE_NUMERATOR`); it is
 * never an editable owner fee, a runtime percentage, or an unverified
 * configuration value. No percentage, owner-commission or reserve input is
 * required by the payout calculator, and each recipient's network fee is
 * deducted independently from that recipient's own gross allocation. Every
 * amount is an integer atomic unit and every calculation is exact BigInt.
 *
 * Durability follows the existing server convention (file-backed JSON under
 * `dataDir`, atomic temp-file + rename writes), matching Phase 1's store.
 */

export {
    CANONICAL_TON_ASSET,
    GRAM_DISPLAY_SYMBOL,
    NANOTONS_PER_TON,
    BASE_STAKE_LABELS,
    BASE_STAKE_TIERS,
    LEDGER_ENTRY_KIND,
    LEDGER_ENTRY_KINDS,
    LEDGER_ENTRY_SCHEMA_VERSION,
    ROOM_LEDGER_PHASE,
    LEDGER_CAPABILITIES,
    LEDGER_FORBIDDEN_OPERATIONS,
    isLedgerEntryKind
} from "./LedgerConstants.js";

export {
    LedgerEntryError,
    LedgerReplayError,
    CorruptedLedgerRecordError,
    LedgerStorageError,
    PayoutAllocationConfigError,
    PayoutFeeError,
    PayoutSettlementError,
    PayoutValidationError
} from "./LedgerErrors.js";

export {
    CurrencyMapping
} from "./CurrencyMapping.js";

export {
    PayoutAllocationConfig,
    WINNER_SHARE_NUMERATOR,
    WINNER_SHARE_DENOMINATOR,
    APPROVED_WINNER_RULE_ID,
    APPROVED_WINNER_RULE_TEXT
} from "./PayoutAllocationConfig.js";

export {
    LedgerEntry,
    generateLedgerEntryId
} from "./LedgerEntry.js";

export {
    PayoutPlan,
    PayoutTransfer
} from "./PayoutPlan.js";

export {
    RoomPayoutCalculator
} from "./RoomPayoutCalculator.js";

export {
    LedgerStore,
    atomicWriteJson
} from "./LedgerStore.js";

export {
    RoomLedger,
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    PAYOUT_RECIPIENT_ROLE
} from "./RoomLedger.js";
