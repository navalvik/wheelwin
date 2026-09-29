# Mainnet Room-Wallet-Only Startup Decoupled from Retired GameEscrow Readiness Gate

Date: 2026-09-29

Task: Decouple the ACTIVE Mainnet startup path from the retired
GameEscrow/Mainnet deployer readiness gate, because WheelWin player finance is
now Room-Wallet-only on both Testnet and Mainnet. Branch:
`payment/room-wallet-integration`.

---

## 1. Scope

- Startup readiness diagnostics for the active Mainnet path
  (`_runTonMainnetReadinessDiagnostics` in `server/app.js`).
- The legacy GameEscrow Mainnet readiness modules
  (`server/diagnostics/TonMainnetReadiness.js`,
  `server/config/validateMainnetConfiguration.js`,
  `server/config/tonNetworkProfiles.js`) — inspected, NOT modified.
- Room Wallet runtime resolution and settlement composition
  (`roomWalletConfig.js`, `RoomWalletRuntimeResolver.js`,
  `RoomWalletService.js`, `RoomWalletSettlementRouter.js`,
  `ContractSettlementManager.js`) — inspected, NOT modified.
- Stale test reconciliation for the Room-Wallet-only architecture
  (test files only).
- NOT in scope / NOT touched: Page4 payment logic, PaymentSession payment
  routing, Room Wallet settlement logic, refund logic, network handoff
  logic, wallet catalogs, Testnet Room Wallet catalog, Railway variables,
  Vercel configuration, GameEscrow readiness validation itself.

## 2. Files Inspected

Context (per `.clinerules` pre-analysis rule):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-29_mainnet_local_sync_baseline_audit.md`

Source:

- `server/app.js` (startup sequence ~L809; readiness diagnostics ~L4607;
  Room Wallet composition ~L1347/L1497/L1511/L1652/L1680/L1771)
- `server/diagnostics/TonMainnetReadiness.js`
  (`evaluateMainnetReadiness`, `assertMainnetStartupSafe`,
  `setTonMainnetReadiness`, `printTonMainnetReadiness`)
- `server/diagnostics/DeployPipelineForensics.js` (`printDeployBlock`)
- `server/config/validateMainnetConfiguration.js`
- `server/config/tonNetworkProfiles.js`
- `server/config/ton.js` (`loadTonConfig`)
- `server/config/startupValidation.js`
- `server/payment/roomWallet/roomWalletConfig.js`
  (`isRoomWalletOnlyFinancialPath`, `composeRoomWalletSettlementRouter`)
- `server/payment/roomWallet/RoomWalletRuntimeResolver.js`
- `server/payment/roomWallet/RoomWalletService.js`
- `server/payment/RoomWalletSettlementRouter.js`
- `server/payment/ContractSettlementManager.js` (spot checks)
- `server/gameplay/PaymentSessionManager.js` (spot checks: participant
  `paymentDestination` / neutralized `contractAddress`)
- Tests: `server/tests/mainnetReadiness.test.js`,
  `roomWalletOnlyPlayerPayment.r18s72.test.js`,
  `roomWalletAppComposition.test.js`, `roomWalletRuntimeResolver.test.js`,
  `roomWalletSettlement.r18s75.test.js`,
  `roomWalletSettlementRouter.test.js`, `roomWalletService.test.js`,
  `helpers/dummyRoomWallet.js`

## 3. Architecture Findings

1. `server/app.js` startup calls `_runTonMainnetReadinessDiagnostics()`
   (app.js ~L809) on every boot.
2. For `TON_NETWORK=mainnet` that method, unchanged since the GameEscrow
   era, did ALL of the following:
   - required the GameEscrow artifact present and loadable
     (`verifyGameEscrowArtifact({ requirePresent: true, requireLoadable:
     true })` on mainnet) and threw `GameEscrow artifact missing` when the
     retired artifact is not shipped/pinned;
   - ran `evaluateMainnetReadiness({ requireLiveWallet: true })`, which
     requires `TON_MAINNET_ORACLE_ADDRESS`,
     `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`,
     `TON_GAME_ESCROW_ARTIFACT_SHA256`, and a live deployer wallet
     identity derived from `TON_DEPLOYER_MNEMONIC`;
   - called `assertMainnetStartupSafe(...)` (app.js ~L4753), which fails
     closed without the oracle pin, the deployer pin, the artifact
     SHA/presence/loadability, deployer identity match, and additionally
     requires `readiness.status === "PASS"`.
3. Player finance is no longer GameEscrow-based:
   `isRoomWalletOnlyFinancialPath()` (`roomWalletConfig.js`) returns `true`
   unconditionally ("WheelWin player finance is Room-Wallet-only on both
   networks. Smart-contract player-payment paths are intentionally not a
   fallback"), and app.js wires Room-Wallet-only finance into
   PaymentSessionManager, GameStartAuthorization, the incoming observer
   (`roomWalletPaymentIntakeEnabled`) and settlement
   (`RoomWalletSettlementRouter` via `composeRoomWalletSettlementRouter`).
4. The Room Wallet runtime configuration stays authoritative at startup:
   `createRoomWalletRegistryFromEnv(process.env)` (app.js ~L1652) fails
   closed unless a complete 64-wallet catalog (rooms 1..64,
   WalletContractV4 identity, `ROOM_WALLETS_MAINNET_JSON` on Mainnet with
   no cross-network fallback) is present.
5. Baseline (pre-change) measured test state: `mainnetReadiness.test.js`
   PASS, `roomWalletRuntimeResolver.test.js` PASS,
   `roomWalletOnlyPlayerPayment.r18s72.test.js` 2/6 pass,
   `roomWalletAppComposition.test.js` 3/13 pass,
   `roomWalletSettlement.r18s75.test.js` 2 stale failures,
   `roomWalletSettlementRouter.test.js` 2/4 pass,
   `roomWalletService.test.js` 0/2 pass. All stale failures assert the
   removed game-mode-gated Room Wallet config and the removed app.js
   GameContractManager/legacy-settlement wiring (removed by commits
   `2b20b6b` -> `1f83e17`), not the readiness gate.



## 4. Lifecycle Flow

After this change, `_runTonMainnetReadinessDiagnostics()`:

1. ACTIVE ROOM-WALLET-ONLY PATH — if
   `network === "mainnet" && isRoomWalletOnlyFinancialPath({ env:
   process.env })`:
   - records a SKIP snapshot via `setTonMainnetReadiness({ status: "SKIP",
     network: "mainnet", activeNetwork, escrowMode, endpoint, reasons:
     ["RoomWallet-only financial path - legacy GameEscrow Mainnet
     readiness (oracle pin, deployer pin, artifact SHA256, deployer
     identity) is not required"] })`;
   - prints it via `printTonMainnetReadiness()` (public fields only);
   - logs `TonMainnetReadiness=SKIP (RoomWallet-only financial path |
     active=mainnet)` via `this._logger.startupLine(...)`;
   - `return`s BEFORE the GameEscrow artifact verification, before
     `evaluateMainnetReadiness`, before the deployer wallet identity
     probe, and before `assertMainnetStartupSafe`.
2. LEGACY / DRY-RUN GAMEESCROW READINESS PATH — for any runtime that is
   not Room-Wallet-only (and for Testnet, which never enters the branch),
   the entire pre-existing body is preserved byte-for-byte: mnemonic
   identity probe, artifact present/loadable verification,
   `evaluateMainnetReadiness`, wallet identity debug snapshot,
   dry-run debug print, and the mainnet `assertMainnetStartupSafe`
   fail-closed gate. The dry-run tooling
   (`server/scripts/check-mainnet-readiness.js`) calls
   `evaluateMainnetReadiness` directly and is untouched.

Mainnet Room-Wallet-only startup requirements are unchanged where they
belong: `TON_NETWORK=mainnet` is still required by `loadTonConfig`, the
Mainnet endpoint selection still comes from `profiles.mainnet`, and the
complete 64-wallet Mainnet catalog is still required and validated by
`RoomWalletRuntimeResolver` at `createRoomWalletRegistryFromEnv` in the
startup composition.

## 5. Ownership Boundaries

- `server/app.js` remains the owner of startup diagnostics; the change is
  an additive, explicitly named readiness branch inside the existing
  diagnostics method. No lifecycle ownership moved.
- `TonMainnetReadiness.js` remains the single owner of Mainnet GameEscrow
  readiness evaluation; its exported functions are untouched, so legacy
  and dry-run behavior are preserved by construction.
- `roomWalletConfig.isRoomWalletOnlyFinancialPath()` remains the single
  authoritative financial-path decision; the readiness branch consumes it
  instead of introducing a parallel decision.
- `RoomWalletRuntimeResolver` remains the single owner of Room Wallet
  catalog authority (64 wallets, WalletContractV4 identity, per-network
  variables); nothing was added around it.

## 6. Risks

- **Low:** The Room-Wallet-only skip is Mainnet-scoped
  (`network === "mainnet" && isRoomWalletOnlyFinancialPath(...)`), so the
  Testnet startup path is byte-identical to before (regression-tested).
- **Low:** The legacy branch is currently unreachable at runtime because
  `isRoomWalletOnlyFinancialPath()` is unconditionally `true` (Room Wallet
  is the only player-finance path by architecture). It is intentionally
  KEPT, not deleted, so a future non-Room-Wallet-only runtime and the
  dry-run tooling keep their fail-closed GameEscrow gate.
- **Low:** The SKIP readiness snapshot intentionally reports no oracle /
  deployer / artifact fields (`null`), so any admin panel consuming
  `getTonMainnetReadiness()` sees an explicit, safe `SKIP` instead of a
  misleading FAIL or a missing record. No secrets are included.
- **Pre-existing (not introduced here):**
  - `server/tests/contractSettlement.manager.test.js` crashes at its line
    267 ("settlement started") — stale legacy-settlement expectation in an
    untouched test + untouched module.
  - `server/tests/paymentSession.manager.test.js` fails at its line 1134 —
    pre-existing, untouched files.
  - `server/tests/roomWalletSettlementAdapter.test.js` "partial room-wallet
    refunds return exactly the paid amount and confirm on chain" —
    pre-existing; refund behavior is explicitly out of scope for this task.
  - `server/tests/roomWalletGameReadiness.test.js` "C. legacy mode still
    requires Deposit FULL and GameEscrow PAYMENTS_COMPLETE" — pre-existing
    legacy-mode expectation in untouched files.

## 7. Recommendations

Do not implement automatically.

1. Reconcile the remaining pre-existing stale suites listed in Risks in a
   dedicated test-hygiene stage (each failure predates this task and is
   unrelated to the readiness gate).
2. Decide the fate of `_stage2_tmp_out.txt` (delete or git-ignore) in a
   separate approved stage.
3. When the Mainnet Room Wallet catalog is provisioned later, it must be
   validated through the existing `RoomWalletRuntimeResolver` path only
   (see `docs/MAINNET_ROOM_WALLET_PROVISIONER.md`); no new validation path
   is needed for startup.
4. Keep `TonMainnetReadiness.js` untouched until the GameEscrow path is
   formally retired from the codebase; do not "simplify" the legacy branch
   away before that decision.

## 8. Changes Made

### Exact files changed

1. `server/app.js` — added the explicit Room-Wallet-only readiness branch
   at the top of `_runTonMainnetReadinessDiagnostics()` (+50 lines,
   comments + branch; legacy body unchanged).
2. `server/tests/mainnetRoomWalletReadinessDecoupling.test.js` — NEW
   focused regression test (7 tests, coverage A/B/C/D below).
3. `server/tests/roomWalletOnlyPlayerPayment.r18s72.test.js` — stale
   assertions updated to the current Room-Wallet-only architecture
   (unconditional financial-path decision, full 64-wallet dummy catalog
   composition, participant `paymentDestination` instead of the
   neutralized `contractAddress`, current app.js wiring regexes).
4. `server/tests/roomWalletAppComposition.test.js` — stale composition
   tests updated to the current `composeRoomWalletSettlementRouter` /
   `RoomWalletSettlementRouter` semantics (no legacy adapter, fail-closed
   catalog requirement, current app.js wiring regexes).
5. `server/tests/roomWalletSettlement.r18s75.test.js` — 2 stale tests
   updated to current wiring.
6. `server/tests/roomWalletSettlementRouter.test.js` — 2 stale tests
   updated to current router semantics (unavailable without adapter; no
   legacy fallback).
7. `server/tests/roomWalletService.test.js` — 2 stale tests updated to the
   fail-closed resolver (full catalog compose; throws without config).
8. `AI_CONTEXT/CLINE_REPORTS/2026-09-29_mainnet_room_wallet_readiness_decoupling.md`
   — this report.

### Exact reason the old readiness gate blocked Room-Wallet-only Mainnet

On `TON_NETWORK=mainnet`, startup unconditionally executed the retired
GameEscrow deployer readiness sequence, which throws when any of the
following legacy variables/artifacts are absent (none of which are needed
by the Room-Wallet-only player-finance architecture):


### Exact implementation

`server/app.js`, method `_runTonMainnetReadinessDiagnostics()` — an
explicit, additive branch inserted immediately after
`const network = this._tonConfig?.network ?? null;`:

```js
if (network === "mainnet" && isRoomWalletOnlyFinancialPath({ env: process.env })) {

    setTonMainnetReadiness({
        status: "SKIP",
        network: "mainnet",
        activeNetwork: network,
        escrowMode: this._tonConfig?.gameEscrowMode ?? null,
        endpoint: this._tonConfig?.profiles?.mainnet?.endpoint ?? null,
        reasons: [
            "RoomWallet-only financial path - legacy GameEscrow Mainnet "
                + "readiness (oracle pin, deployer pin, artifact SHA256, "
                + "deployer identity) is not required"
        ]
    });

    printTonMainnetReadiness();

    this._logger.startupLine(
        "TonMainnetReadiness=SKIP (RoomWallet-only financial path | "
            + `active=${network ?? "unknown"})`
    );

    return;

}
```

Everything below the branch (the LEGACY / DRY-RUN GAMEESCROW READINESS
PATH) is unchanged: `const mnemonic` probe, `deriveDeployerWalletIdentity`,
`verifyGameEscrowArtifact` (with
`requirePresent: network === "mainnet" || gameEscrowMode === "game"`),
`evaluateMainnetReadiness({ requireLiveWallet: network === "mainnet" })`,
`setTonMainnetWalletIdentityDebug`, `printTonMainnetReadiness()`,
`printTonMainnetDryRunDebug(readiness)`, and the
`assertMainnetStartupSafe(...)` fail-closed gate for
`network === "mainnet"`.

Not required anymore on the active Mainnet Room-Wallet-only path:

- `TON_MAINNET_ORACLE_ADDRESS`
- `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`
- `TON_DEPLOYER_MNEMONIC`
- `TON_GAME_ESCROW_ARTIFACT_SHA256`
- GameEscrow artifact presence / loadability
- GameEscrow deployer identity
- `assertMainnetStartupSafe()` is NOT called for this path
- `GAME_ESCROW_MODE` (`game` or `v4`) does NOT control Room Wallet finance;
  `isRoomWalletOnlyFinancialPath()` remains the authoritative decision

Still required on the active Mainnet Room-Wallet-only path:

- `TON_NETWORK=mainnet` (required by `loadTonConfig`)
- Mainnet TON endpoint selection (`profiles.mainnet`)
- Room Wallet runtime configuration: complete 64-wallet Mainnet catalog
  (rooms 1..64, `WalletContractV4` identity validation) via the existing
  `RoomWalletRuntimeResolver` / `createRoomWalletRegistryFromEnv`

Safety of the diagnostic output: the SKIP snapshot and the startup line
contain only status/network/escrowMode/endpoint/reason text. No secrets,
no `secretKey` values, no mnemonics, no API keys, no Room Wallet JSON.

## Tests executed and results

Runner: `node --test` (Node v24.19.0) from `server/`.

Mandated set (all PASS after the change):

```
node --test tests/mainnetReadiness.test.js
node --test tests/roomWalletOnlyPlayerPayment.r18s72.test.js
node --test tests/roomWalletAppComposition.test.js
node --test tests/roomWalletRuntimeResolver.test.js
```

Combined run of the mandated set plus the new focused test and the two
reconciled room-wallet suites: 40 tests, 40 pass, 0 fail.

- `mainnetReadiness.test.js` — PASS
- `roomWalletOnlyPlayerPayment.r18s72.test.js` — PASS (6/6)
- `roomWalletAppComposition.test.js` — PASS (13/13)
- `roomWalletRuntimeResolver.test.js` — PASS (6/6)
- `roomWalletSettlement.r18s75.test.js` — PASS
- `mainnetRoomWalletReadinessDecoupling.test.js` — PASS (7/7)

Additional relevant suite:

- `roomWalletSettlementRouter.test.js` — PASS (4/4, after stale-assertion
  reconciliation)
- `roomWalletService.test.js` — PASS (2/2, after stale-assertion
  reconciliation)
- `tonTestnetWalletReadiness.test.js` — PASS ("all assertions passed")
- `roomWalletIncomingObserver.test.js` — PASS (27/27)
- Pre-existing failures (NOT introduced by this task; files untouched):
  `contractSettlement.manager.test.js` (line 267, stale legacy-settlement
  expectation), `paymentSession.manager.test.js` (line 1134),
  `roomWalletSettlementAdapter.test.js` "partial room-wallet refunds..."
  (refund logic out of scope), `roomWalletGameReadiness.test.js` "C. legacy
  mode..." (legacy-mode expectation).

New focused regression coverage
(`server/tests/mainnetRoomWalletReadinessDecoupling.test.js`):

- A. Mainnet + Room-Wallet-only: financial-path decision stays `true`
  regardless of `GAME_ESCROW_MODE`; readiness skip branch is Mainnet-scoped,
  precedes `verifyGameEscrowArtifact(` / `evaluateMainnetReadiness(` /
  `assertMainnetStartupSafe(` and `return`s before the legacy body; skip
  diagnostic prints `TonMainnetReadiness=SKIP (RoomWallet-only financial
  path ...)` with no secret material; SKIP snapshot carries no oracle pin,
  no deployer pin, no artifact fields, no wallet address.
- B. Mainnet + legacy/dry-run (unchanged, proven by direct calls):
  `validateMainnetConfiguration` still fails on missing
  `TON_MAINNET_ORACLE_ADDRESS` / `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`;
  `assertMainnetConfigurationValid` still throws;
  `evaluateMainnetReadiness({ requireLiveWallet: true })` still returns
  `FAIL` with pin + identity + `mnemonic required` reasons;
  `assertMainnetStartupSafe` still throws `Mainnet startup validation
  failed: ...` even with a perfect artifact; oracle pin must still match
  the deployer pin when both are set.
- C. Testnet regression: `loadTonConfig({ TON_NETWORK: "testnet",
  GAME_ESCROW_MODE: "game" })` unchanged (testnet/game, mainnet profile

## Confirmations

- Page4 payment code was untouched: the change set contains no `client/`
  files (verified via `git status --porcelain`; only `server/app.js`, six
  `server/tests/` files and this report).
- PaymentSession payment routing, Room Wallet settlement logic, refund
  logic and network handoff logic were NOT modified: no changes to
  `PaymentSessionManager.js`, `ContractSettlementManager.js`,
  `RoomWalletSettlementRouter.js`, `RoomWalletSettlementAdapter.js`,
  `roomWalletConfig.js`, `RoomWalletRuntimeResolver.js`,
  `RoomWalletService.js`, `RoomWalletIncomingObserver.js`.
- No Mainnet wallet catalog was generated: the tests use deterministic
  in-memory dummy fixtures only (`server/tests/helpers/dummyRoomWallet.js`);
  no `ROOM_WALLETS_MAINNET_JSON` value or file was created and no wallet
  secrets were created or exposed anywhere.
- Railway variables were not changed manually; no deployment was performed.
- Vercel configuration was not changed manually.
- No legacy files were deleted; `TonMainnetReadiness.js`,
  `validateMainnetConfiguration.js`, `tonNetworkProfiles.js` and the whole
  legacy readiness body in `app.js` are preserved.
- The payment architecture was not rewritten: one additive readiness branch
  plus test reconciliation only.

## Git

- Branch: `payment/room-wallet-integration` (no new branch created).
- Commit message:
  `fix(mainnet): decouple Room Wallet startup from GameEscrow readiness`
- Fix commit SHA: recorded in the final handoff message and below after
  push.
- Pushed to `origin/payment/room-wallet-integration`.

  v4, testnet endpoint); Room-Wallet-only finance on Testnet unchanged;
  readiness skip is Mainnet-scoped so Testnet keeps the legacy report path.
- D. Room Wallet architecture: `RoomWalletSettlementRouter` remains the
  settlement adapter on Mainnet; `isRoomWalletOnlyFinancialPath()` remains
  active; blockchain deploy remains skipped (`_skipBlockchainDeploy` guard
  intact; app.js still wires
  `roomWalletPaymentIntakeEnabled: isRoomWalletOnlyFinancialPath`);
  resolver still requires a complete 64-wallet Mainnet catalog (63 wallets,
  Testnet-variable fallback and malformed key material all fail closed) and
  the registry keeps signing material out of its entries.


- `TON_MAINNET_ORACLE_ADDRESS` not configured →
  `"TON_MAINNET_ORACLE_ADDRESS is not configured"`;
- `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS` not configured →
  `"TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is not configured"`;
- `TON_GAME_ESCROW_ARTIFACT_SHA256` missing →
  `"Expected GameEscrow artifact SHA256 missing ..."`;
- GameEscrow artifact file absent on Mainnet →
  `"GameEscrow artifact missing"` (thrown directly by the app.js artifact
  check);
- deployer mnemonic/identity unavailable →
  `"Deployer wallet identity not available (mnemonic required)"`;
- and finally `assertMainnetStartupSafe` →
  `"Mainnet startup validation failed: TON_MAINNET_ORACLE_ADDRESS is not
  configured; TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is not configured"`
  plus the `readiness.status !== "PASS"` throw.

All of these belong to the retired GameEscrow/Mainnet deployer path, not
to Room Wallet player finance, whose authority is the Room Wallet runtime
resolver (64-wallet catalog + WalletContractV4 identity) and the
`RoomWalletSettlementRouter` settlement adapter.

- `RoomWalletSettlementRouter` remains the settlement adapter boundary
  consumed by `ContractSettlementManager`; untouched.
