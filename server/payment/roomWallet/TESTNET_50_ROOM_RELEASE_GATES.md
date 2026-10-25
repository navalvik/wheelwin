# WheelWin Testnet — 50 simultaneous rooms: financial release gates

Status: **DRAFT / NOT DEPLOYABLE**. Scope: native GRAM transfers through 64 server-managed Room Wallets, never escrow or payment smart contracts.

## Capacity and wallet ownership

- Maximum **50 simultaneously active game rooms**, always **3 players per room**: up to 150 concurrent players/payments.
- Wallet pool contains 64 addresses, of which at least 14 remain outside the 50 active-room ceiling. These 14 are **headroom, not guaranteed spendable or unlocked wallets**.
- Never allocate a wallet held by an active game, pre-Page5 refund quarantine, or unresolved settlement.
- If more than 14 wallets are quarantined, allow fewer than 50 active games. Never repurpose a wallet because the server is busy.
- `ROOM_MAX_CONCURRENT` defaults to 50 and values above 50 are rejected. Existing Railway Variables must be reviewed before deployment.
- Persist quarantine **before** releasing the room number; restore it before attaching rooms or admitting clients after restart.
- Current state uses one authoritative Railway game-server process and a local single-writer financial volume. **Do not scale it to multiple identical writable replicas.** Shared wallet allocation and `seqno` need an external transactional lock before horizontal scaling.

## Testnet payment monitoring

- Primary TonCenter observer polls up to 8 **active payment** wallets per cycle with a rotating offset. Idle wallet catalog entries are not polled.
- If the primary provider has repeated infrastructure failures (such as HTTP 542), skip it temporarily (30-second circuit) instead of blocking all 50 rooms with repeated timeouts.
- **Expired-room read-only scanner now implemented:** TonAPI cursor pagination (before_lt) and TonCenter v3 LT windowing (end_lt). Both independently scan back through the PaymentSession start and must match receipts. Bounded to 12 pages per source per pass; incomplete or conflicting history raises retryable error.
- Optional fallback requires matching wallet transaction **LT, 256-bit hash, sender, destination, value, timestamp and success status** across TonAPI and TON Center v3.
- One process-wide observer owns a bounded scheduler: maximum two simultaneous HTTP requests per fallback provider, with at least 1,200 ms between request starts for that provider. Overflow, timeout, HTTP 429, index lag or disagreement mean **UNCONFIRMED / PENDING**, never "unpaid".
- Free/public API provider quotas and real end-to-end confirmation latency **are not validated for 50 rooms**. A dedicated, appropriately sized blockchain indexer/API plan and live Testnet load test are required before claiming a 50-room SLA.
- When `ROOM_WALLET_DUAL_SOURCE_ENABLED` is not `true`, the fallback is disabled. No Mainnet activation.

## Refund and winner/owner settlement safeguards still required

- Pre-Page5 room teardown now synchronously persists a wallet quarantine **before** RoomManager releases a room number. The opt-in closed-room reconciliation worker runs after startup, scans two quarantined rooms per sweep on the same shared provider budget as the active-payment fallback, and persists chain-proof-backed obligations. This workflow does not depend on active PaymentSession state.
- The worker is enabled only by setting `ROOM_WALLET_EXPIRED_RECONCILIATION_ENABLED=true` and remains disabled by default. It has a 10-second sweep timer, a maximum of two wallets per sweep, a retry backoff, and no wallet signing methods.
- Both providers must paginate back through payment-session creation to create an exhaustive historical scan. Scans that fail or overflow the page budget do **not** clear a wallet quarantine.
- A refund-obligation ledger proves **money owed**, not that a payout was sent. The journal persists signed message hash, seqno, recipient, gas and value and holds ambiguous operations across restart. New `RoomWalletSingleWriterGate` uses atomic filesystem locks on a **single shared persistent volume**, never TTL-based lock stealing. New `RoomWalletGuardedOutboundExecutor` can broadcast a prepared signed TON V4 BOC **only when explicitly enabled and supplied with signer/broadcaster dependencies**. It is NOT wired into the live settlement/refund/residual-sweep paths and remains disabled in normal runtime. These old paths must all be migrated or disabled before deployment.
- No payment twice: verify outgoing transaction hash, logical time, recipient amount, and increasing `seqno` before advancing to the next wallet transfer.
- Use the same deterministic, serial, replay-safe mechanism for winner payments and owner commission. Preserve recipient-borne gas policy and the 0.01 GRAM room safety margin.
- Both pre-Page5 refund and post-Page5 settlement quarantines must have a carefully verified, durable, chain-proof-backed closure state, **not** a timeout-based automatic release. Until implemented, a closed game can remain quarantined permanently.
- No live broadcast execution or autonomous outgoing payout worker is wired in this PR. The new executor's once-only broadcast behavior was tested exclusively with injected mock transport and fake/fixture wallets. TON signing preparation itself does not call a network broadcaster.
- `RoomWalletOutboundIntentJournal` persists an immutable REFUND or WINNER/OWNER plan before any signer would broadcast. A signed external hash and seqno are durably HELD; all responses transition to CONFIRMATION_UNKNOWN until independent chain proof + advanced seqno mark CHAIN_CONFIRMED. The guarded executor parses the **actual TON V4 signed external BOC** and validates wallet address, seqno, expiration, send mode, internal recipient and exact nanogram value before its one and only RPC broadcast. If signing preparation fails BEFORE the durable hold, only the current exclusive owner may release the lock; once held, no time-based release or automatic retry is possible.
- `RoomWalletAdapter.prepareSignedTransfer()` provides a sign-only method with authoritative seqno/balance checks and no RPC broadcast. `ROOM_WALLET_GUARDED_OUTBOUND_ONLY=true` is an explicit, off-by-default **kill switch** for old direct `sendTransfer()` calls: enabling it before migrating the legacy payout caller will cause payouts to fail closed. Keep it off in all running environments until the entire financial system is ready.
- WINNER and OWNER payout intents are derived exclusively from ContractSettlementManager frozen persisted payoutPlan and validated against authoritative settlement amount, destinations, recipient-paid gas evidence and owner 0.01 GRAM retained reserve.
- Post-Page5 room destruction also durably quarantines wallets until winner/owner settlement reconciliation. This is a separate marker from PRE-Page5 refund quarantine and is excluded from the refund worker. Restart reallocation guards restore both markers. The current PR intentionally has no automatic quarantine clearance.

## Failed Testnet game `oj7v`

- Olga: 0.998611722 GRAM refund **confirmed on-chain** (source wallet tx hash `decf4284978c28153475f4ac94668f77e233bed93d6aaf32f3ed9e737514565c`).
- Lena and Bob: refunds **outstanding**. No second or third transfer was sent during this PR.
- Before their refunds, re-check the current chain state and `seqno` for Room Wallet #1 and guarantee no duplication. Do not bypass a blocked transfer mechanism.

## Testing

- Latest offline focused suite: **158 passed / 158 total**, including an actual TON V4 sign-only BOC fixture (test key material only), BOC internal recipient/value verification, once-only mocked transport, HTTP 542 ambiguous-reply handling, 50 concurrent filesystem wallet locks, restart replay, pre-sign failure recovery, legacy-broadcast kill switch, existing seqno settlement tests, durable outbound intent journal, winner/owner frozen payout math, pre/post-Page5 quarantine, paginated scan and 50-room provider budgeting. `node --check app.js` also succeeded.
- Prior `roomWalletActiveWalletPolling.test.js`: **11 passed / 11 total**.
- `roomNumberWalletMapping.test.js`: **5 passed / 8 total**. Three failures were reproduced **both on the historical base and this branch**, unrelated to the new 50-room ceiling.
- Old `setupExpiryRoomWalletRefund.test.js` did not complete within an isolated 22-second window; not a passing result.
- No true 50-room end-to-end Testnet stress test, full financial settlement, controlled restart recovery, or final production release gate has yet passed.

## Rollout restrictions

Keep PR #21 **DRAFT**. Do not merge to `main`, redeploy Testnet, restart Telegram payments, or touch Mainnet until the remaining recovery, wallet-release and settlement execution paths are completed and verified. The historical successful-game branch stays untouched.
