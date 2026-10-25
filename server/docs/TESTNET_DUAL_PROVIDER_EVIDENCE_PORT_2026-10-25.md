# WheelWin — read-only dual-provider evidence integration (2026-10-25)

Branch: `integrate/testnet-readonly-dual-provider-20261025`, based on `prep/main-testnet-3player-5min-50rooms`.

## Scope

Ported from draft PR #21 only five independent, **read-only** Testnet provider components: inbound agreement, outgoing transaction identity proof, two-source account tips, deep expired-room chain scanner and bounded process-local request budget. Added six offline fixture suites and pinned `@ton/core@0.63.1` solely for TON address parsing. The wallet signer, outbound executor, deposit acceptance, settlement workers, old payment routes and Railway variables are not modified.

## Verification before commit

An isolated Vercel sandbox ran `npm ci --ignore-scripts`, `node --check app.js`, and 18 selected offline test files, resulting in **71 passing tests across 18 selected files / 0 failures**. The 6 new test files alone yielded **54 passing tests**. These are Node test-file entry points containing nested assertions; not an end-to-end live Testnet transaction run.

## Explicit non-goals and hard gates

- This slice is **not wired into the production payment observer**; it cannot enable any payments, refunds, payouts or wallet release. Avoid claiming that dual provider protection is active until an independently reviewed integration wires it.
- Live acceptance stays disabled (`REFUND_EXECUTION_NOT_READY`). No escrow or smart contracts. No signed transfers.
- Do not merge into `main`, deploy Railway/Vercel, use Mainnet or allocate Room Wallet #1 with unresolved Lena/Bob refunds based solely on this proof library.
- Next slice: guarded, durable refund/payout intent journal and operator-safe recovery, with tests preserving five-minute deadline, single-writer, 50-room capacity and three-player gate. Check that every component correctly uses actual Testnet indexer schemas and fail-closed handling before real operations.
