# Issue #17 implementation and verification

Date: 2026-10-24

Task: Testnet native GRAM refund safety, signer boundary and recovery integration.

## 1. Scope

New isolated worktree `G:/WheelWin_Issue17`, branch `codex/issue-17-testnet-refund-safety`, based on `952ce604` of `restore/testnet-64-wallet-page4`. The original checkout and its unrelated staged/modified files were not edited. No main/PR #15 changes, merge, deployment, live acceptance toggle, real transfer, escrow or new contract.

## 2. Files inspected

Issue #17 body and all comments (zero comments), project context/rules, Testnet workflow, refund plan/store/provider/coordinator, Wallet V4 decoder/signature inspector, runtime factory, finality, refund tests, PR #15 estimator and its tests, and official TON/Vercel documentation. See [design and blockers](../../docs/issue17-testnet-refund-safety.md).

## 3. Architecture findings

The base already had a strict plan, signer/broadcaster interfaces and independent V4 verification. Cross-process transitions still relied on cached obligations; UNKNOWN lookup used recipient/amount without signed-request identity; finality did not validate actual fees. Fee assurance is still unavailable with the permitted design.

## 4. Lifecycle flow

Settled intent identity -> unchanged fee-plan validation -> durable plan -> exclusive wallet hold and UNKNOWN -> independently verified signed body -> durable hash receipt -> injected broadcast -> independent finality and actual-fee check. UNKNOWN recovery observes only; no automatic resend.

## 5. Ownership boundaries

Payment/refund owners retain authority. Room lifecycle, wallet catalog, three-player gate and 5-minute timer are unchanged. Tests use temporary stores, ephemeral in-memory signing keys and mocked network evidence. No secrets or signed BOCs are persisted.

## 6. Risks

Critical: no pre-send exact-fee/no-subsidy guarantee; production signer/state-reader/broadcaster/observer adapters are not provisioned. High: recipient execution tracing, V4 network replay protection, shared-volume/power-loss validation and manual recovery of crash locks remain outstanding. Live acceptance remains disabled.

## 7. Recommendations

Keep this PR Draft and all live acceptance disabled. Do not relabel the advisory quote or relax plan/finality checks. Resolve the explicit blockers in the design document before considering any future release.

## 8. Changes made

Copied PR #15's estimator/tests/dependencies unchanged; added durable transition locking and wallet claims; persisted signed-body identity before broadcasting; tightened settled-intent authorization, message snapshots, diagnostics and fee/finality checks; enabled read-only recovery; added integrated real-signature and cross-process offline tests and PR release-gate coverage. Added branch-only Vercel deployment suppression.

## 9. Exact validation results

Final local verification used Node **22.23.4**, Windows x64. Every test/build command in the Testnet release gate was executed. No test was skipped or weakened.

| Gate | Exact result |
| --- | --- |
| 1: `node tests/refundOutgoingExecution.test.js` | PASS, 39 deterministic scenarios |
| 1: `node --test tests/refundIssue17.integration.test.js tests/toncenterTestnetRefundFeeEstimator.test.js tests/walletV4NativeRefundDecoder.test.js tests/signedNativeGramRefundEvidence.test.js` | 44 passed, 0 failed, 0 skipped (19 new integration cases/subcases) |
| 1: original seven-file safety command in workflow | 31 passed, 0 failed, 0 skipped |
| 2: `node tests/refundLifecycle.test.js` | PASS |
| 2: JSON/SQLite replay and runtime-storage command in workflow | 10 passed, 0 failed, 0 skipped |
| 3: `paymentCore.phase1.test.js` | PASS, 237 assertions |
| 3: `payment/paymentCore.test.js` | PASS, 47 assertions |
| 3: `payment/paymentRuntimeIntegration.test.js` | PASS, 100 assertions / 12 sections |
| 3: `payment/roomPaymentSessionAdapter.test.js` | PASS, 567 assertions / 23 sections |
| 3: `payment/page4ReconnectPaymentRecovery.test.js` | PASS, 42 assertions / 9 sections |
| 4: `node --test tests/roomWalletRailwayCatalog.test.js` | 16 passed, 0 failed, 0 skipped |
| 5: acceptance/default-submitter assertions | PASS; also asserted branch deployment suppression in both Vercel configs |
| 5: three client native-transfer/WalletSubmission/TonConnectUIAdapter test files | 9 passed, 0 failed, 0 skipped |
| 5: client build (`node node_modules/vite/bin/vite.js build`, the `npm run build` entry point) | PASS; existing ineffective dynamic-import and >500 kB chunk warnings |
| Patch integrity | `git diff --check`: PASS |

Total TAP counts: **110 passed, 0 failed, 0 skipped**, plus the outgoing/lifecycle scripts and **993 payment-lifecycle assertions**. Full command lines are preserved in `.github/workflows/testnet-release-gate.yml`; test logs and command/exit-code JSON are in the local temporary directory `wheelwin-issue17-results`.

Installation qualification: standard server `npm ci --ignore-scripts=false --no-audit --no-fund` failed first on Node 24 (no Visual Studio C++ toolchain), and then on Node 22 (`node-gyp` completion callback failure while obtaining headers). Tests attempted during cleanup failed with missing-module errors; these are superseded by the successful complete run above. `npm ci --ignore-scripts --no-audit --no-fund` then installed all 177 server packages successfully. The pinned `better-sqlite3` package includes its native prebuild: independently opening a real in-memory database under Node 22 reported **SQLite 3.53.4**. SQLite tests actually executed; they were not stubbed or skipped. Client `npm ci --ignore-scripts --no-audit --no-fund` passed (331 packages).

The local standard-install step is therefore **not green**, despite all final gate test/build commands passing. The Draft PR records the separate Linux GitHub Actions release-gate result, including installation. Financial release blockers remain regardless of CI outcome.
