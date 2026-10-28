# Pn6f: verified payment incident

Investigation date: 2026-10-28. Local repository only. No transfers submitted by this investigation.

## Screenshot QR decoding

Decoded all three QR images from `codex-clipboard-a5723e4a-2fb9-4326-8251-067da1d58a34.png` using jsQR 1.4.0. Each contains the same room destination and amount:

```text
ton://transfer/0QC0LQzn3bmA6fnG6dvIi0HjO18FIdQrbUb_FL-QyT_Bc0ul?amount=1000000000&text=WW1%3AWW_fac02f61ae63a858ef3c0f0b419deac5
ton://transfer/0QC0LQzn3bmA6fnG6dvIi0HjO18FIdQrbUb_FL-QyT_Bc0ul?amount=1000000000&text=WW1%3AWW_4a6cf1e6c5d1bf85eeedfcf9f5291919
ton://transfer/0QC0LQzn3bmA6fnG6dvIi0HjO18FIdQrbUb_FL-QyT_Bc0ul?amount=1000000000&text=WW1%3AWW_b3e1aca7f8d13efc91495d5a1018515a
```

Order: Lena, Olga, Bob (bound through persisted room manifest and session history). `1000000000` atomic units = 1 Gram. QR encoding is not proof that the wallet scanner applies its parameters.

## Independent read of Testnet transactions

Read the destination's Toncenter v3 history using the application's existing authenticated read-only transport. Incoming transactions are non-aborted and not bounced. Sender addresses match the three persisted expected senders. All three have an empty message body (`decoded.@type = empty_cell`), without the required payment comment.

| Player | Received Gram | Transaction hash |
| --- | ---: | --- |
| Lena | 1 | `Ue1ZyKULUaclL63d7KpidBNCREQZxIs/ZhC+nD/AtBc=` |
| Olga | 1 | `qylKDsnXPGg0mzoRmWQ78pcafusVWe42HVJNSNSfK6E=` |
| Bob | 3 | `pgiQfSqYtayUKyoVg5FWh1pWhomUQddadKbTghqpPzI=` |

All arrived during the original room window, before closure at 11:54:40 UTC. Total received: 5 Gram. These are received transfers, NOT accepted stakes or confirmed refund obligations.

## Confirmed server failure path

- The three payment intents remain PENDING, each requiring 1 Gram.
- No incoming principal was credited for Pn6f; the ledger only contains required stakes.
- `RefundLifecycleCoordinator.prepareClosedRoom` creates refund debts only from SETTLED intents backed by INCOMING_PRINCIPAL. With zero principal entries it returns an empty list.
- Closure was persisted under `refunds/closed-refund-rooms`, but no Pn6f refund obligation was created.
- Closed-room recovery calls the same strict payment matcher, so a missing reference remains unmatched. Bob's transfer additionally has the wrong amount.
- At 11:53:39.081 UTC the room log also records `Toncenter rate limit reached (HTTP 429)`. Provider availability is another observed issue; it does not explain away the missing comments or wrong amount.
- Room wallet 7 remains reserved for Pn6f. Do not release/reassign it or delete its records while this incident is unresolved.

## Required repair boundaries

1. Verify Android scanner/deep-link processing with amount AND comment before declaring the payment UX repaired. The previous QR change did not establish this.
2. Keep exact server validation for entry to the game. A direct wallet transfer permits the sender to choose any amount; QR cannot enforce it.
3. Add durable separate accounting and reconciliation for received transfers that fail stake matching (missing reference, overpayment, underpayment, duplicates, late receipts). Do not fabricate SETTLED intents or treat overpayment as a correct stake.
4. Refund actual verified received amounts to verified original senders, deducting the player-borne network fee, using an idempotent receipt-backed refund path with outgoing finality checks. Existing settled-intent-only refund execution is insufficient for this incident.

## Recovery completed later on 2026-10-28

Restored all three received transfers through masterchain-indexed Toncenter source and recipient histories, independently matched to TonAPI Testnet. Persisted separate receipts and idempotent refund obligations without changing the PENDING stake intents into SETTLED payments.

The local server's existing authorized Testnet refund worker executed the obligations after restart. All three refunds now have state COMPLETE, verified against both independent indexed histories. No retry of an ambiguous broadcast was made.

| Player | Gross debt Gram | Actual refund Gram | Player-borne fee budget Gram | Source transaction hash |
| --- | ---: | ---: | ---: | --- |
| Lena | 1 | 0.998611542 | 0.001388458 | `QkLV6BIAVJ0Rs9E7ftcqoA52SUTSHXpI38HgUxBkquA=` |
| Olga | 1 | 0.998611542 | 0.001388458 | `r6uhSlQ3ft6HNCGIzxMGZ1KOdQUHwiAMl9caEDWWT04=` |
| Bob | 3 | 2.998898932 | 0.001101068 | `9aiSgFw1HuXemd43CFHPvWGYTu7yGwQcrS+Bb5jrGAU=` |

Total actual refunds: 4.996122016 Gram. Total deducted fee budgets: 0.003877984 Gram. Budgets include the configured margin; they are not a claim that the blockchain consumed that exact amount as fees.

Repairs: separate durable incoming receipts, capture before stake matching, receipt-backed debts for closed rooms, wallet holds, bounded historical two-provider recovery, receipt-backed outgoing reconciliation. Corrected actual API shapes (`finalized` string, numeric atomic amounts, address objects) and SDK Address handling in native RPC service. Source files remain local; no GitHub push or deployment.

Historical evidence: archives for 2026-10-01 room 2S5J (FULLY_PAID, stakes 1/1/2.5) and 2026-10-07 room CEzQ (FULLY_PAID; pot 3, winner gross 2.85, organizer gross 0.15) were inspected, alongside commit 3383893e. They confirm the previous direct room-wallet/TonConnect flow. Historical escrow code was not restored.

Remaining separate issue: the Android wallet's QR/deep-link scan still needs end-to-end validation of amount and comment. This refund repair does not claim that a new full Page1–Page6 session has passed.
