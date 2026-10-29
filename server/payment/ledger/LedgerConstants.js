/**
 * Phase 4 — Internal ledger + payout accounting: fixed constants.
 *
 * Currency / stake rules (Section 1 of the Phase 4 brief):
 *   - the transferred asset is NATIVE TON;
 *   - `1 Gram = 1 TON = 1_000_000_000` nanotons;
 *   - `10 Gram = 10_000_000_000` nanotons;
 *   - every internal amount is an integer number of atomic units (nanotons);
 *   - the display denomination (`Gram`) is kept strictly separate from the
 *     canonical asset identifier (`TON`).
 *
 * The canonical mapping itself lives in `CurrencyMapping.js`. This module only
 * names the pieces so there is exactly one source of truth.
 */

/**
 * Canonical asset identifier for native TON. Never a display symbol.
 */
export const CANONICAL_TON_ASSET = "TON";

/**
 * Player-facing display denomination label. `Gram` is a DISPLAY symbol only and
 * is never assumed, by itself, to equal any amount of TON — the atomic value
 * always comes from an explicit `CurrencyMapping`.
 */
export const GRAM_DISPLAY_SYMBOL = "Gram";

/**
 * Exact atomic-unit mapping for native TON: 1 TON = 1_000_000_000 nanotons, and
 * (per the brief) 1 `Gram` display unit is defined to equal 1 TON.
 */
export const NANOTONS_PER_TON = 1_000_000_000;

/**
 * Player-facing base stake labels. These are display labels only; their atomic
 * values are derived from an explicit `CurrencyMapping`.
 */
export const BASE_STAKE_LABELS = Object.freeze([
    "1 Gram",
    "10 Gram"
]);

/**
 * Explicit display-unit amounts for the base stake tiers. 1 Gram -> 1 display
 * unit, 10 Gram -> 10 display units. Atomic amounts are computed by the
 * currency mapping (never hardcoded here).
 */
export const BASE_STAKE_TIERS = Object.freeze([
    Object.freeze({ label: "1 Gram", displayUnits: 1 }),
    Object.freeze({ label: "10 Gram", displayUnits: 10 })
]);

/**
 * Append-only ledger entry kinds. Every value this ledger represents is an
 * entry of exactly one kind.
 */
export const LEDGER_ENTRY_KIND = Object.freeze({
    PLAYER_STAKE: "PLAYER_STAKE",
    SECTOR_PURCHASE: "SECTOR_PURCHASE",
    INCOMING_PRINCIPAL: "INCOMING_PRINCIPAL",
    PAYOUT_PLAN: "PAYOUT_PLAN",
    WINNER_GROSS_ALLOCATION: "WINNER_GROSS_ALLOCATION",
    OWNER_GROSS_ALLOCATION: "OWNER_GROSS_ALLOCATION",
    GAS_RESERVE_ALLOCATION: "GAS_RESERVE_ALLOCATION",
    NETWORK_FEE_RESERVATION: "NETWORK_FEE_RESERVATION",
    NETWORK_FEE_ACTUAL: "NETWORK_FEE_ACTUAL",
    NET_PAYOUT: "NET_PAYOUT",
    PAYOUT_SETTLEMENT: "PAYOUT_SETTLEMENT",
    OWNER_COMMISSION_WAIVED: "OWNER_COMMISSION_WAIVED"
});

export const LEDGER_ENTRY_KINDS = Object.freeze([
    LEDGER_ENTRY_KIND.PLAYER_STAKE,
    LEDGER_ENTRY_KIND.SECTOR_PURCHASE,
    LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
    LEDGER_ENTRY_KIND.PAYOUT_PLAN,
    LEDGER_ENTRY_KIND.WINNER_GROSS_ALLOCATION,
    LEDGER_ENTRY_KIND.OWNER_GROSS_ALLOCATION,
    LEDGER_ENTRY_KIND.GAS_RESERVE_ALLOCATION,
    LEDGER_ENTRY_KIND.NETWORK_FEE_RESERVATION,
    LEDGER_ENTRY_KIND.NETWORK_FEE_ACTUAL,
    LEDGER_ENTRY_KIND.NET_PAYOUT,
    LEDGER_ENTRY_KIND.PAYOUT_SETTLEMENT,
    LEDGER_ENTRY_KIND.OWNER_COMMISSION_WAIVED
]);

/**
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isLedgerEntryKind(kind) {

    return LEDGER_ENTRY_KINDS.includes(kind);

}

/** Durable-storage identity for persisted ledger entries. */
export const LEDGER_ENTRY_SCHEMA_VERSION = 1;

/** Phase marker for the internal ledger / payout accounting layer. */
export const ROOM_LEDGER_PHASE = 4;

/**
 * Explicit capability descriptor. This layer can NEVER transfer, broadcast,
 * sign, touch a contract/provider, or collect real payments. It only keeps the
 * internal ledger and computes validated payout plans.
 */
export const LEDGER_CAPABILITIES = Object.freeze({
    phase: ROOM_LEDGER_PHASE,
    transfersEnabled: false,
    broadcastsEnabled: false,
    walletSigningEnabled: false,
    smartContractsEnabled: false,
    providerAccessEnabled: false,
    realPaymentCollectionEnabled: false,
    storesWalletSecrets: false
});

/**
 * Operations that must never appear on the ledger / payout surface. Tests and
 * reviewers use this as the exact forbidden-operation list.
 */
export const LEDGER_FORBIDDEN_OPERATIONS = Object.freeze([
    "sendTransaction",
    "sendRawTransaction",
    "broadcast",
    "deploy",
    "deployContract",
    "sign",
    "signTransaction",
    "GameEscrow",
    "DepositContract",
    "estimateFee",
    "runGetMethod",
    "getBalance"
]);
