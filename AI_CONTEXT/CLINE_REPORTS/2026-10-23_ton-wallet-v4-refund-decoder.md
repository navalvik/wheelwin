# TON Wallet V4 Signed Refund Decoder — Completion Report

Date: 2026-10-23

Task: Complete the TON Wallet V4 transaction decoder and implement reliable validation of signed native GRAM transfers used by WheelWin Testnet (64-room-wallet refund path), on branch `restore/testnet-64-wallet-page4`.

## 1. Scope

Analyzed and verified the existing TON BOC parser and Wallet V4 signed-message validation code under `server/payment/refund/` and `server/tests/`. Completed deterministic test coverage for the required validation cases. Verified structural decoding, Ed25519 signature verification, destination/amount/send-mode checks, fail-closed rejection, and on-GitHub CI execution. No production source was missing or broken; the gap was test coverage for three required cases.

## 2. Files Inspected

- `server/payment/refund/StrictTonBocFraming.js` — BOC framing + CRC32C validation
- `server/payment/refund/OrdinaryTonBocCells.js` — BOC cell parsing / reference resolution
- `server/payment/refund/WalletV4NativeRefundDecoder.js` — Wallet V4 signed-body decoder
- `server/payment/refund/WalletV4RefundEd25519.js` — Ed25519 signature verification
- `server/payment/refund/WalletV4SignedPayloadSignature.js` — Ed25519 payload-signature verification
- `server/payment/refund/WalletV4SignedNativeGramRefundInspector.js` — refund inspector (trusted state binding)
- `server/payment/refund/SignedNativeGramRefundEvidence.js` — signed-message evidence contract
- `server/payment/refund/CatalogBoundWalletV4SignatureVerifier.js` — catalog-bound key resolution
- `server/tests/walletV4NativeRefundDecoder.test.js`
- `server/tests/walletV4RefundEd25519.test.js`
- `server/tests/walletV4SignedNativeGramRefundInspector.test.js`
- `server/tests/walletV4SignedPayloadSignature.test.js`
- `server/tests/ordinaryTonBocCells.test.js`
- `server/tests/strictTonBocFraming.test.js`
- `server/tests/fixtures/nativeRefundV4BocFixture.js`
- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`, `CURRENT_STATE.md`, `AI_WORKING_RULES.md`, `DEVELOPMENT_HISTORY.md`

## 3. Architecture Findings

The WheelWin payment domain (server-authoritative, TON Testnet, 64 independent room wallets) already contained a complete, dependency-free TON Wallet V4 simple-send decoder built on Node built-ins only (`node:crypto`, `node:test`, `node:assert`). The BOC layer enforces strict framing (magic `0xb5ee9c72`, one root, topological forward references, bounded cells/size, CRC32C when present). The body decoder accepts only Wallet V4 opcode 0 (simple send), a single internal-transfer message reference, native GRAM, send_mode 1 or 3, bounce enabled, no extra currency, no state-init, empty body, workchain 0. Signature verification is Ed25519 over the SHA-256 hash of the unsigned body cell (512 signature bits stripped, references preserved). The public key is sourced exclusively from independently authenticated Testnet wallet state (`walletStateReader.getVerifiedWalletState`, verified on-chain, V4R2 code hash) or the room-wallet catalog — never from the message being validated. The inspector additionally binds wallet ID, seqno, network, globalId (-3), and expiration (validUntil in (now, now+600]).

## 4. Lifecycle Flow

1. `signedRefundBocHashOrNull` — base64/format/framing pre-check + SHA-256 of the raw BOC bytes.
2. `decodeWalletV4NativeRefundBody` — structural BOC decode, then TL-B field extraction and validation (wallet_id, valid_until, seqno, opcode=0, send_mode, destination, amount, bounce, no extra currency/fees/state-init/body).
3. Ed25519 verification (`verifyWalletV4SignedPayloadSignature` / `verifyWalletV4RefundEd25519`) over the unsigned body cell hash using a trusted 32-byte key.
4. Inspector (`WalletV4SignedNativeGramRefundInspector.inspect`) — binds source wallet from trusted on-chain state, re-checks signature, destination, amount, send_mode, seqno, version V4R2, code hash, expiration; returns `verified: true` only for exactly one message matching the expected plan.
5. `verifyInspectedNativeGramRefund` — binds the inspected verdict back to the exact signed BOC bytes and authoritative plan (idempotency key, from, to, amount, send_mode, bounce).

Structural decoding, cryptographic verification, and execution confirmation are clearly separated; a valid signed message is not treated as proof of on-chain execution.

## 5. Ownership Boundaries
## 8. Changes Made

- `server/tests/walletV4NativeRefundDecoder.test.js` — added test: reject a signed body carrying additional unauthorized outgoing transfers (root referencing two message cells → `CELL_COUNT_UNSUPPORTED`).
- `server/tests/walletV4SignedNativeGramRefundInspector.test.js` — `fixture()` now accepts an optional `validUntil`; added tests: expired Wallet V4R2 message rejected (inspection + pre-broadcast check); unsupported Wallet V4 revision rejected.
- Commit `de33e3b539b47c0a4443b57a94c0dfcd17b1f053` on `restore/testnet-64-wallet-page4`, pushed to origin. No production code changed; working tree clean; `main` untouched.

## 9. Test Commands Executed

All run locally in `G:\kilo-work\wheelwin` (Node v24.19.0), using only built-in modules:
- `node server/tests/walletV4NativeRefundDecoder.test.js` — 4/4 pass
- `node server/tests/walletV4RefundEd25519.test.js` — 3/3 pass
- `node server/tests/walletV4SignedNativeGramRefundInspector.test.js` — 5/5 pass
- `node server/tests/walletV4SignedPayloadSignature.test.js` — 2/2 pass
- `node server/tests/ordinaryTonBocCells.test.js` — 3/3 pass
- `node server/tests/strictTonBocFraming.test.js` — 4/4 pass

Total TON suite: 21/21 pass. Full server suite not runnable locally (missing `server/node_modules`/`express`); pre-existing and unrelated.

## 10. Test Results

- Passed: 21/21 TON decoder/signature/BOC tests (including the 3 newly added).
- Failed: none.
- Not executed: full server suite (blocked by missing `server/node_modules`, pre-existing).
- GitHub Actions: workflow run #235 "GRAM Jetton isolated safety tests" completed successfully for commit `de33e3b` on `restore/testnet-64-wallet-page4` (Oct 23, 2026). Prior runs on this branch also show the Wallet V4 refund safety tests passing.

## 11. Changes Made

Commit `de33e3b539b47c0a4443b57a94c0dfcd17b1f053` — 2 files changed, 45 insertions, 2 deletions (both test files). No production code modified.

## 12. Remaining Blockers

None for the decoder. The decoder structurally decodes and cryptographically verifies supported Wallet V4 signed native GRAM transfers, validates destination/amount/send-mode, rejects unauthorized transfers, and passes deterministic tests. On-chain broadcast/finality is explicitly out of scope and must be verified separately.

## 13. Confirmations

- Branch: `restore/testnet-64-wallet-page4`; commit SHA `de33e3b539b47c0a4443b57a94c0dfcd17b1f053`.
- Commit pushed to remote `origin`; confirmed present on `origin/restore/testnet-64-wallet-page4`.
- `main` NOT modified.
- Railway and Vercel NOT modified; no deployment performed.
- Local `G:\WheelWin` NOT accessed or modified (work performed on a fresh clone at `G:\kilo-work\wheelwin`).
- No wallet private keys, seed phrases, or secrets accessed, exposed, printed, or committed.
- No escrow, DepositContract, Jetton Master, or legacy payment architecture restored.
- No gameplay, timers, player rules, or Page4–Page6 UI changed.
- No live blockchain transfers performed.


- Payment domain owns TON integration and financial validation (this change).
- Refund business rules, wallet allocation, payment-session state machine, three-player gate, timers, winner payout, owner fee, and the 0.01 GRAM reserve were NOT touched.
- No escrow, DepositContract, Jetton Master, or legacy smart-contract architecture was restored or created.
- Blockchain execution/fees remain out of scope and are verified separately.

## 6. Risks

- Critical: none. No financial state, keys, or secrets were touched or exposed.
- High: none. Fail-closed parsing and bounded BOC (MAX_CELLS 256, MAX_SIZE 65536) prevent resource exhaustion.
- Medium: the full server suite cannot run locally because `server/node_modules` is not installed (`express` missing) — a pre-existing environment limitation unrelated to the TON decoder, which uses only Node built-ins. GitHub CI runs the targeted safety tests.
- Low: two Ed25519 implementations exist (`WalletV4RefundEd25519`, `WalletV4SignedPayloadSignature`) with slightly different cell-hash helpers; both are tested and correct. Left in place per "do not replace working code."

## 7. Recommendations

- Keep the decoder restricted to Wallet V4 simple-send (opcode 0); do not add multi-action lists unless the payment policy requires them.
- If on-chain finality confirmation is later required, add it as a separate step after decoder validation (per Section 4 of the task).
- Consider installing `server/node_modules` in CI to enable the full server suite locally.
