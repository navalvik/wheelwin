# GameEscrow / DepositContract / DepositPackage — Remaining Links Analysis (Room Wallet Era)

Date: 2026-09-27

Task: Analysis ONLY of the remaining GameEscrow / DepositContract / DepositPackage
references in the current WheelWin codebase (`g:\WheelWin`, branch
`payment/room-wallet-integration`, working tree). Determine, for every reference,
what it does and whether it can execute during the current authoritative
Testnet payment architecture:

    Player → assigned Room Wallet → PaymentSession → Room Wallet settlement/refund

No source files were modified, deleted, or refactored. No architecture was
restored. This report is the only file created.

Note on working-tree state: `git status --short` at analysis time shows
`M server/gameplay/PaymentSessionManager.js` and untracked
`server/tests/restoreRoomWalletRefund.test.js` — an in-progress implementation
of the restore-refund gap described in
`AI_CONTEXT/CLINE_REPORTS/2026-09-27_payment_session_restore_room_wallet_refund_gap.md`.
All line numbers below refer to this working tree.

The `.kilo/worktrees/powerful-trunk/` parallel checkout was explicitly excluded
from every search; all findings are from the main tree only.

---

## 1. Scope

- All `GameEscrow` / `DepositContract` / `DepositPackage` (case-insensitive,
  plus `GAME_ESCROW`, `DEPOSIT_PACKAGE`) references in `server/`, `client/`,
  `contracts/`, `config/`, `docs/` of the main tree.
- Runtime wiring in `server/app.js` (composition root) to decide what can
  actually execute.
- The six flows named in the task: Page4 payment, PaymentSession,
  GAME_START_AUTHORIZED / GAME_INITIALIZED, Room Wallet refund, normal
  settlement, recovery/restore.

## 2. Files Inspected

Context (per .clinerules): `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`,
`AI_CONTEXT/AI_WORKING_RULES.md`,
`AI_CONTEXT/CLINE_REPORTS/CURRENT_TESTNET_PAYMENT_INTERFACE_MAP.md`,
`AI_CONTEXT/CLINE_REPORTS/2026-09-27_payment_session_restore_room_wallet_refund_gap.md`,
`AI_CONTEXT/CLINE_REPORTS/2026-09-27_creator_left_room_wallet_refund_fix.md`.

Source read in depth (main tree):

- `server/app.js` (composition root: 1320–1860, 3605–3640, 4590–4680, 4995–5035)
- `server/gameplay/PaymentSessionManager.js` (1–340, 400–780, 900–1260, 1360–1420, 1920–2270, 2590–2900)
- `server/gameplay/GameContractManager.js` (200–260, 2420–2500)
- `server/gameplay/GameplayLifecycle.js` (150–220)
- `server/gameplay/GameStartAuthorization.js` (460–545)
- `server/gameplay/partialPaymentEscrowUnwind.js` (helpers)
- `server/payment/ContractSettlementManager.js` (220–285, 1240–1300, 2240–2310, 2810–2845)
- `server/payment/BlockchainMonitor.js` (2855–2920 + grep map)
- `server/payment/roomWallet/roomWalletConfig.js` (1–120)
- `server/payment/roomWallet/RoomWalletIncomingObserver.js` (comments)
- `server/history/SessionHistoryArchiveManager.js` (690–725)
- `server/deposit/DepositOrchestrator.js`, `DepositSessionCoordinator.js`,
  `EntryDeploymentAuthorizationAutomation.js` (24–110),
  `GameEscrowDeploymentAuthorizationAutomation.js`,
  `DeploymentAuthorization.js`, `DeploymentAuthorizationCoordinator.js`,
  `deploymentAuthorizationValidation.js`, `DepositActivationVerificationCoordinator.js`,
  `DepositMonitor.js`, `DepositOnChainVerificationCoordinator.js`,
  `projectDepositForPlayer.js`, `resolveDepositOrchestrationFinancials.js`
- `server/payment/ton/buildDepositStateInit.js`, `verifyDepositArtifact.js`,
  `buildGameEscrowStateInit.js`, `verifyGameEscrowArtifact.js`,
  `TonGameContractAdapter.js`, `buildGameContractSnapshot.js`,
  `buildSettleMessagePlan.js`, `gameContract/GameContractSerializer.js`,
  `artifacts/GameEscrow.code.json`, `artifacts/DepositContract.code.json`
- `server/events/EventTypes.js` (GAME_ESCROW_* / DEPOSIT_* names)
- `server/socket/RoomLobbyBridge.js` (860–950, 6920–7100), `server/socket/lobbyProtocol.js`
- `server/recovery/TonFinancialRecovery.js`, `RecoveryCheckpointManager.js` (grep map)
- `client/src/pages/Page4Payment.jsx` (1–30)
- `client/src/game/session/page4PaymentPhase.js` (full),
  `authoritativeSessionModel.js` (825–860), `index.js`
- `client/src/payment/buildEntryPaymentTransaction.js` (full),
  `buildTonConnectPaymentTransaction.js` (full)
- `client/src/context/AuthoritativeSessionContext.jsx` (370–420)
- `client/src/socket/SocketSyncLayer.js` (385–400), `EngineBridge.js` (250–268),
  `socketEvents.js`
- `client/src/i18n/translations.js` (`payment.waitingGameEscrow` keys)
- `contracts/game_escrow/GameEscrow.tact`, `contracts/deposit/DepositContract.tact`,
  `contracts/wrappers/*`, `contracts/compilables/*`, `contracts/tests/*`

## 3. Method

1. `git grep` over tracked main-tree files for all name variants
   (case-insensitive) → per-file match counts (152 files; ~60 non-test source
   files). The `.kilo` worktree was excluded from all searches.
2. Composition-root audit of `server/app.js` to decide which modules are
   instantiated and which events are produced/consumed at runtime.
3. Per-reference tracing of every producer → consumer chain for the events
   `DEPOSIT_PACKAGE_PUBLISHED`, `DEPOSIT_SEAT_FUNDED`, `DEPOSIT_FULL_ONCHAIN`,
   `DEPLOY_AUTHORIZATION_VALID`, `GAME_ESCROW_STAKE_CONFIRMED`,
   `GAME_ESCROW_SETTLEMENT_VERIFIED/REJECTED`, `GAME_ESCROW_CANCEL_CONFIRMED`,
   `GAME_ESCROW_REFUND_CONFIRMED`, `ESCROW_*`.
4. Flow-by-flow trace of the six flows named in the task.
5. No reference was classified by name alone; every classification below cites
   its execution path (or the exact guard that makes it unreachable).

## 4. Executive Conclusion

**No remaining GameEscrow / DepositContract / DepositPackage reference can
interfere with the current Room Wallet payment, game-start, refund, or
settlement flow.** Every on-chain capability of the old smart-contract
architecture is unreachable in the production composition:

- `GameContractManager` is **not instantiated** anywhere in `server/` outside
  tests (`new GameContractManager` exists only in test files). Its production
  consumers therefore degrade to no-ops.
- `DepositOrchestrator` is **explicitly not initialized**
  (`server/app.js:1729`: "Legacy DepositOrchestrator is intentionally not
  initialized. Player payments use only the authoritative Room Wallet path."),
  so `DEPOSIT_PACKAGE_PUBLISHED` — the sole trigger of the deposit deployment
  chain — has **no producer**.
- `isRoomWalletOnlyFinancialPath()` (`server/payment/roomWallet/roomWalletConfig.js:40`)
  **returns `true` unconditionally** ("WheelWin player finance is
  Room-Wallet-only on both networks"), so `PaymentSessionManager` always runs
  in `_roomWalletPaymentIntakeEnabled = true` mode, which short-circuits every
  GameEscrow sync/watch path.
- `ContractSettlementManager` is wired with
  `settlementAdapter = RoomWalletSettlementRouter` (enabled) and, when that
  adapter is active, **does not even subscribe** to
  `GAME_ESCROW_SETTLEMENT_VERIFIED/REJECTED`
  (`ContractSettlementManager.js:251–265, 272–279`).
- `PaymentSessionManager.createPaymentSession` is fail-closed on
  `session.roomWalletAddress` (`PaymentSessionManager.js:508–522`) and never
  requires an on-chain contract in intake mode.
- `GameStartAuthorization` authorizes game start from the Room Wallet ledger
  only (`GameStartAuthorization.js:462–492`) and contains **zero** escrow /
  contract references.

What DOES still execute under a GameEscrow name is non-financial:

1. A startup **artifact integrity gate** (`verifyGameEscrowArtifact`,
   `server/app.js:4622–4660`) — Testnet defaults to `gameEscrowMode = "game"`,
   so a missing/corrupt `GameEscrow.code.boc` fails server boot. It performs
   no chain interaction and no payment semantics.
2. A **legacy-named observer event** `GAME_ESCROW_STAKE_CONFIRMED`, emitted by
   `BlockchainMonitor` for *Room Wallet* payment confirmations
   (`BlockchainMonitor.js:2886–2908`) and consumed only by
   `SessionHistoryArchiveManager` as financial evidence
   (`SessionHistoryArchiveManager.js:700–707`).
3. Configuration/diagnostic mode resolution (`server/config/gameEscrowMode.js`,
   `ton.js`, `tonNetworkProfiles.js`, `validateMainnetConfiguration.js`,
   `diagnostics/TonMainnetReadiness.js`, `TonTestnetWalletReadiness.js`) and
   the startup log line `GameEscrowMode=...` (`app.js:3621–3625`).
4. Client-side pure helpers with legacy names
   (`isGameEscrowOnlyPlayerPayment`, `canStakeGameEscrow`,
   `PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE`) that now mean "Room-Wallet payable".

The only chain of old-architecture code that can still *run* at runtime is the
**deposit-era recovery reactivation** (`TonFinancialRecovery` restores persisted
DepositSessions and re-arms `DepositMonitor` watches). It can only act on
historical persisted deposit data, emits informational projections only, and
cannot touch Room Wallet financial truth (details in §8).

## 5. Active Execution-Path Findings (can execute today)

### 5.1 Server startup — GameEscrow artifact integrity gate (ACTIVE, non-financial)

- File/function: `server/app.js` lines 4622–4660;
  `server/payment/ton/verifyGameEscrowArtifact.js`;
  `server/config/gameEscrowMode.js` (`defaultGameEscrowModeForNetwork` —
  Testnet default `game`).
- What it does: at startup it verifies
  `server/payment/ton/artifacts/GameEscrow.code.boc` — presence, SHA256 (when
  an expected hash is configured), and StateInit loadability. On Testnet
  (`gameEscrowMode === "game"`) `requirePresent` and `requireLoadable` are
  `true`; violations throw and abort startup. On mainnet (`v4` mode) it only
  verifies when an expected hash exists (mismatch still throws, 4632–4637).
- Can it execute? **Yes — every boot.**
- Interference with Room Wallet flow: none (no chain interaction, no payment
  semantics). Operational risk only: deleting/corrupting the legacy artifact
  breaks Testnet boot (§8, D-1).

### 5.2 Live payment confirmation — legacy-named observer event (ACTIVE, evidence only)

- File/function: `server/payment/BlockchainMonitor.js`
  `_processConfirmedPayment` region, lines 2886–2908 — emits
  `EVENT_TYPES.GAME_ESCROW_STAKE_CONFIRMED` for **every confirmed watched
  payment**, including current per-room Room Wallet watches (`watchPayment`
  created with `contractAddress = roomWalletAddress`). The event name is a
  historical name; the payload is a Room Wallet transfer observation. The
  payment flow itself consumes `PAYMENT_TRANSACTION_CONFIRMED` (2863–2884)
  and `PAYMENT_BLOCKCHAIN_CONFIRMED` (2911+) emitted alongside it.
- Consumer: **only** `server/history/SessionHistoryArchiveManager.js:700–707`
  (archives it into the `GAME_COMPLETED` payment-confirmation chain).
  `PaymentSessionManager` does **not** subscribe to it — its `initialize()`
  (lines 216–290) subscribes only `PAYMENT_CONNECTION_READY`,
  `PAYMENT_TRANSACTION_DETECTED/CONFIRMED`, `TRANSACTION_FAILED`,
  `PAYMENT_BLOCKCHAIN_CONFIRMED/REJECTED`, `ROOM_DESTROYED`,
  `SESSION_FINISHED`, `SERVER_SHUTDOWN`.
- Can it execute? **Yes — on every confirmed Room Wallet payment.**
- Interference: none. Observer fact + archive evidence only. Documented as
  intentional in `CURRENT_TESTNET_PAYMENT_INTERFACE_MAP.md` ("legacy event
  noise on the active path").

### 5.3 Configuration / diagnostics (ACTIVE, non-financial)

- `server/config/gameEscrowMode.js` (29 refs) — resolves `game | v4` from
  env/network; imported by `config/ton.js:1`, `config/tonNetworkProfiles.js`,
  `config/validateMainnetConfiguration.js`, `ContractSettlementManager.js:23–26`.
- `server/config/tonNetworkProfiles.js` (32 refs) — network profiles +
  artifact metadata; imports `verifyGameEscrowArtifact.js`.
- `server/config/validateMainnetConfiguration.js` (13),
  `server/config/schemas/environmentSchema.js` (11),
  `server/config/validators/validateEnvironment.js` (11),
  `server/config/loaders/loadEnvironment.js` (3),
  `server/config/RuntimeConfiguration.js` (1) — env validation messages
  ("Leave unset to keep legacy Deposit + GameEscrow readiness",
  `TON_GAME_ESCROW_ARTIFACT_SHA256`, mainnet `v4` rollback policy).
- `server/diagnostics/`: `TonMainnetReadiness.js` (22),
  `TonTestnetWalletReadiness.js` (5), `DeployPipelineForensics.js` (26 —
  `setGameEscrowDeployDebug` etc.), `SettlementPipelineForensics.js` (19),
  `GameEscrowE2EReport.js`, `GameEscrowSoakReport.js`,
  `TonMainnetWalletIdentityDebug.js` (1).
- `server/app.js:3621–3625` — startup line `GameEscrowMode=... (network=...)`.
- `server/.env.example:135,161` — comments only.
- Interference: none. The mode value `game` enables no GameEscrow payment
  code in the current composition (its only on-chain consumers are guarded
  or uninstantiated — §7).

### 5.4 Client Page4 — legacy-named pure helpers (ACTIVE, Room-Wallet semantics)

- `client/src/game/session/page4PaymentPhase.js`:
  - `isGameEscrowOnlyPlayerPayment()` (122–131) — returns `true`
    unconditionally; name is legacy, meaning is "Room-Wallet-only".
  - `canStakeGameEscrow()` (163–177) — name is legacy; actually "local player
    can pay entry to the Room Wallet" (`canConfirmLocalPayment` +
    `roomWalletAddress` present). Used by `resolveEntryPaymentComponents`
    (includeStake), `canSubmitEntryPayment`, `resolvePage4PaymentPhase`.
  - `PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE` (20) — legacy phase **label**
    returned by `resolvePage4PaymentPhase` (248) when a destination/session
    exists but the local player cannot pay yet; display routing only.
  - `resolvePlayerPaymentDestination()` (63–74) — returns
    `paymentSession.roomWalletAddress` **only**; participant
    `contractAddress` is never a fallback (the server also nulls it:
    `PaymentSessionManager.js:2606`).
  - Deposit gates hard-disabled, all return `false`:
    `shouldShowWaitingCreatorDeposit` (133), `isDepositActivationVerified`
    (139), `isDepositFull` (145), `canDeployDeposit` (151), `canFundSeat`
    (157), `canIncludeFundSeatInEntry` (180), `shouldShowDepositAction` (270).
- `client/src/payment/buildEntryPaymentTransaction.js` (125–201): `allowDeploy`
  / `allowFund` are constants `false` (153–154); `gameEscrowOnly`,
  `gameEscrowAddress`, `depositPackage`, `playerIndex` are `void`ed
  (147–151); destination = `paymentDestination ?? roomWalletAddress` (169);
  builds a **plain TON transfer** via `buildTonConnectPaymentTransaction`
  with `plainTransfer: true` (177–183). Lines 163–167 keep a dormant
  "Only the Room Creator may include DepositContract deployment" error that
  is unreachable (`allowDeploy === true` is impossible).
- `client/src/payment/buildTonConnectPaymentTransaction.js`:
  `buildGameEscrowStakePayload()` (21–25) and `buildTonCommentPayload()`
  (15–19) **throw "disabled"**; `buildTonConnectPaymentTransaction` (50–86)
  requires `plainTransfer === true` — smart-contract player payment is
  rejected at the API boundary.
- `client/src/pages/Page4Payment.jsx:13–14` — the component's **only**
  GameEscrow match is a header comment ("GameEscrow / DepositPackage payment
  paths and diagnostic bypasses are not part of this component").
- `client/src/game/session/authoritativeSessionModel.js:843,856` — comment
  "server seat index for GameEscrow STAKE body"; `playerIndex` and
  `contractAddress` are mirrored in the store for display/compat;
  `contractAddress` is never used as a payment destination.
- `client/src/i18n/translations.js` (5×) — `payment.waitingGameEscrow`
  strings (EN/ES/PT/FR/ZH) — UI copy with a legacy name.
- Interference: none. Behaviour is Room-Wallet-only by construction
  (constants and the `plainTransfer` hard requirement), not by data.

## 6. Historical / Evidence Findings (must remain)

These references are financial-record, evidence, or protocol-compatibility
artifacts. They do not execute payment logic, but they anchor financial truth,
audits, and rollback safety. Classification: **KEEP**.

1. **Compiled artifacts + metadata**
   - `server/payment/ton/artifacts/GameEscrow.code.boc` / `.code.json` (3 refs)
   - `server/payment/ton/artifacts/DepositContract.code.boc` (implied by
     metadata) / `DepositContract.code.json` (3 refs) + `artifacts/README.md`
   - Role: integrity-verified evidence of what was deployable per phase;
     the GameEscrow BOC is still loaded by the active startup gate (§5.1).
     Removing them changes startup behaviour (fail-closed by design).
2. **Financial evidence archiving**
   - `server/history/SessionHistoryArchiveManager.js:700–707` — subscribes
     `GAME_ESCROW_STAKE_CONFIRMED` (emitted on the live Room Wallet path,
     §5.2) and persists it into the `GAME_COMPLETED` payment-confirmation
     chain together with `PAYMENT_TRANSACTION_CONFIRMED` (691) and
     `PAYMENT_BLOCKCHAIN_CONFIRMED` (709). Removing the subscription would
     create a hole in financial evidence for current payments.
3. **Deliberate legacy neutralization inside the live model**
   - `PaymentSessionManager._activatePaymentRequests` line 2606:
     `participant.contractAddress = null` — keeps legacy persisted records
     harmless and prevents any client from ever seeing a contract address as
     a destination.
   - `issueDeployedPaymentRequests` lines 696–707: "Legacy
     GameEscrow/DepositContract activation is disabled" — `contractAddress`
     argument `void`ed; activation only against `session.roomWalletAddress`.
   - `PaymentSessionManager.js:40–43` `PAYMENT_READY_CONTRACT_STATUSES`
     + `_assertContractReadyForPayments` (2853–2873) — legacy contract-readiness
     check retained; reachable only in non-intake mode with an existing
     contract (`createPaymentSession` gates it at 412–416; `_resolveContract`
     returns `null` in production because no `gameContractManager` is wired).
4. **Event-name protocol compatibility**
   - `server/events/EventTypes.js`: `GAME_ESCROW_SETTLEMENT_VERIFIED/REJECTED`
     (190–191), `GAME_ESCROW_STAKE_CONFIRMED/REJECTED` (193–194),
     `GAME_ESCROW_REFUND_CONFIRMED/REJECTED` (196–197),
     `GAME_ESCROW_CANCEL_CONFIRMED` (198), `ESCROW_CANCEL_REQUESTED/CONFIRMED/FAILED`
     (200–202), `ESCROW_REFUND_PENDING/CONFIRMED` (203–204),
     `DEPOSIT_PACKAGE_PUBLISHED` (319). Names are part of persisted archives,
     logs, and audit traces; renaming would rewrite financial history.
5. **TON contract sources, wrappers, and build tooling (build/test-time only)**
   - `contracts/game_escrow/GameEscrow.tact` (389 lines),
     `contracts/deposit/DepositContract.tact` (429 lines),
     `contracts/wrappers/GameEscrow.ts`, `contracts/wrappers/DepositContract.ts`,
     `contracts/compilables/GameEscrow.compile.ts`,
     `contracts/compilables/DepositContract.compile.ts`,
     `contracts/blueprint.config.ts`, `contracts/README.md`,
     `contracts/tests/GameEscrow.spec.ts`, `contracts/tests/DepositContract.spec.ts`,
     `contracts/tests/OneWalletEntry.spec.ts`,
     `contracts/scripts/compile-and-export.mjs`.
   - Role: reproduce the exact deployed bytecode for the artifacts in §6.1 and
     for sandbox-level verification. Never imported by server/client runtime.
6. **Validation scripts and test harnesses** (server/tests/*, server/scripts/*)
   - e.g. `gameEscrowE2E.test.js`, `gameEscrowCancelE2E.test.js`,
     `gameEscrowSettle.test.js`, `escrowLifecycleLock.r131h.test.js`,
     `fullyPaidCancellation.r131h.test.js`, `tonGameEscrowDeploy.test.js`,
     `buildGameEscrowStateInit.test.js`, `verifyGameEscrowPayouts/Refunds.test.js`,
     `depositStateInit.r179l12.test.js`, `depositOrchestrator.r179l23.test.js`,
     `r770c1_deploy_init_game.mjs`, `r770c2_open_payments_and_monitor.mjs`,
     `run-game-escrow-e2e.js`, `run-game-escrow-soak.js`,
     `resume-v2i-settle.js`, `verify-v2f-refund.js`,
     `_r18s15_production_page5.mjs`, and the explicit negative guards
     `creatorLeftRoomWalletRefund.test.js` / `setupExpiryRoomWalletRefund.test.js`
     ("No GameEscrow / DepositContract mechanism is involved").
   - Role: regression proof that the Room Wallet paths never touch the old
     mechanism — these assertions are themselves evidence.
7. **Documentation**
   - `docs/R17.8J_GAMEESCROW_DEPLOY_FAILURE_FORENSICS.md`,
     `docs/R17.8N_GAMEESCROW_DEPLOY_RELIABILITY_VALIDATION.md`,
     `docs/architecture/R7.69D-GameEscrow-Production-Audit.md`,
     `docs/architecture/R7.69E-Safe-Codebase-Cleanup-Audit.md` ("Do not touch
     GameEscrow paths…"), `docs/operations/Mainnet-Launch-Checklist.md`,
     `docs/operations/R8.1A-Mainnet-Dry-Run.md`,
     `docs/R17.8H_TON_PAYMENT_CONFIRMATION_AUDIT.md`,
     `docs/R17.8I_PAYMENT_FAILURE_FORENSICS.md`, `docs/MAINNET_MIGRATION_*`,
     plus all `AI_CONTEXT/CLINE_REPORTS/*.md` covering the escrow era.
   - Role: decision history and rollback doctrine (mainnet keeps `v4` until
     GameEscrow cutover is approved).

## 7. Inactive / Legacy Findings (present but not reached)

Every item below is verified unreachable in the production composition. The
exact guard is cited; none of these can fire during the Room Wallet flow.

### 7.1 GameEscrow engine layer (no instance exists)

- `server/gameplay/GameContractManager.js` (9 refs; ~2.5k lines):
  - Not instantiated: `new GameContractManager` appears only in
    `server/tests/*` (5 test files). `app.js` wires
    `PaymentSessionManager` **without** `gameContractManager`
    (app.js:1339–1353), `ContractSettlementManager` without it
    (1503–1519), `RecoveryCheckpointManager` without it (1797–1811),
    `RecoveryOrchestrator` without it (1843–1855),
    `GameplayLifecycle.configureSettlementTeardownGate` without it
    (1545–1547 → `GameplayLifecycle.js:178–189`).
  - Subscriptions (`initialize()`, 233–260): `DEPLOY_AUTHORIZATION_VALID` and
    `PAYMENT_SESSION_COMPLETED`. Even though `PAYMENT_SESSION_COMPLETED` is
    emitted on the live path (PSM `_maybeCompleteSession`, 2809–2812), the
    manager object does not exist, so nothing consumes it for escrow purposes.
  - `requestPartialPaymentEscrowUnwind` / escrow cancel path ending in
    `watchGameEscrowRefunds` (2457) — unreachable (no instance).
- `server/payment/TonGameContractAdapter.js` (52 refs) — the deploy /
  STAKE / SETTLE / CANCEL transport for GameEscrow. Imported only by
  `GameContractManager`'s dependency tree and by
  `server/scripts/r770c1_deploy_init_game.mjs` /
  `r770c2_open_payments_and_monitor.mjs`. Never constructed in production.
- `server/payment/buildGameContractSnapshot.js` (8) — only imported by
  `GameContractManager.js:15`.
- `server/payment/ton/buildSettleMessagePlan.js` (9) — only imported by
  `TonGameContractAdapter.js:31`.
- `server/payment/ton/gameContract/GameContractSerializer.js` (13),
  `GameContractDeserializer.js` (4), `GameContractDtos.js` (2) — adapter,
  scripts, tests only.
- `server/payment/ton/buildGameEscrowStateInit.js` (35) — StateInit/data-cell
  builder; its production importers are only the artifact verifiers
  (`verifyGameEscrowArtifact.js`, `config/tonNetworkProfiles.js`) — the
  active use is the §5.1 integrity gate, not deployment.
- `server/payment/ton/deployerBalancePolicy.js` (1),
  `server/payment/ton/networks/index.js` (1) — support constants for the
  above.

### 7.2 PaymentSessionManager — escrow-era internals (guarded/unsubscribed)

All inside the live file, but each has an explicit dead-end in intake mode
(`_roomWalletPaymentIntakeEnabled === true` in production):

- `syncFromGameEscrow(roomId)` (971–1189) — first statement returns
  `{ skipped: "room_wallet_intake" }` when intake is enabled (977–986).
  Caller: `_finishPaymentSessionRestore` pendingSync loop (946) — harmless
  no-op. `_syncCancelFromGameEscrow` (1195+, `readGameEscrowCancelState`
  at 1221) is called only from `syncFromGameEscrow` (1175) — unreachable.
- Restore-time GameEscrow watches: `_finishPaymentSessionRestore` registers
  legacy blockchain watches only when
  `contractAddress && !this._roomWalletPaymentIntakeEnabled` (903–911).
- `failSession` legacy escrow unwind branch (2202–2245) —
  `needsEscrowUnwind = !this._roomWalletPaymentIntakeEnabled
  && sessionNeedsEscrowUnwind(session) && typeof
  this._gameContractManager?.requestPartialPaymentEscrowUnwind === "function"`
  (2154–2159) — can never be `true` in production (intake always enabled;
  comment 2154–2155: "Never fires in Room-Wallet intake mode").
- Orphaned escrow handlers (methods exist, **no subscription**):
  `_handleGameEscrowRefundConfirmed` (1368), `noteEscrowCancelTx` (1443),
  `_handleGameEscrowCancelConfirmed` (1528). Only comments mention
  `GAME_ESCROW_CANCEL_CONFIRMED` / `GAME_ESCROW_STAKE_CONFIRMED`
  (1522–1605). `noteEscrowCancelTx` has one caller:
  `GameContractManager.js:2438` — uninstantiated.
- `_resolveContract` (2823–2835) — returns `null` without
  `_gameContractManager` → `createPaymentSession` contract gates
  (408–427) and `PAYMENT_READY_CONTRACT_STATUSES` (40–43,
  `_assertContractReadyForPayments` 2853) are skipped in production.

### 7.3 ContractSettlementManager — escrow settlement branches (guarded)

- `initialize()` (234–285): `GAME_ESCROW_SETTLEMENT_VERIFIED/REJECTED`
  subscriptions (255–263) and `BLOCKCHAIN_CONTRACT_STATE_CHANGED` (274–277)
  are registered **only if** `!_isRoomWalletSettlementActive()`
  (228–232: `this._settlementAdapter?.isEnabled?.() === true`). In production
  `settlementAdapter` is the enabled `RoomWalletSettlementRouter`
  (app.js:1491–1519 via `composeRoomWalletSettlementRouter`,
  `isRoomWalletOnlyFinancialPath() === true`) → **not subscribed**.
- Even if invoked, `_handleGameEscrowSettlementVerified` (2817) and
  `_handleGameEscrowSettlementRejected` (2898) early-return when room-wallet
  settlement is active (2830–2834, 2911+) or escrow mode ≠ `game`.
- `_registerGameEscrowPayoutWatch` (3371–3405, calls
  `blockchainMonitor.watchGameEscrowSettlement`) — reachable only from
  branches guarded by `!this._isRoomWalletSettlementActive()`
  (536–539, 1252–1284, 1436–1461) or after the room-wallet adapter path
  already returned (2240–2245 vs. the 2247+ escrow branch).
- All `this._gameContractManager?.markSettlementPending / markWinnerPending /
  completeContract / failContract / updateContractState / getContractBy*`
  calls (965–970, 1457, 1485, 1555, 1913, 2268, 2313, 2674, 2700, 2778,
  2827, 2908, 3236, 3285, 3431, 3527, 3586) — optional-chained no-ops
  (`_gameContractManager` is undefined; not passed at app.js:1503–1519).
- `_resolveEscrowMode` + `GAME_ESCROW_MODE_GAME/V4` constants (23–26,
  198–226) — mode metadata only; drives only the guarded branches above.

### 7.4 Deposit / DepositPackage engine layer

- `server/deposit/DepositOrchestrator.js` (17 refs) — **not initialized**
  (app.js:1729–1730). Contains the **only producer** of
  `EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED` (line 786) and the only caller of
  `DepositSessionCoordinator.recordDepositPackage` (line 530 →
  `DepositSessionCoordinator.js:154`, which freezes `depositPackage` into
  session metadata). `freezeDepositPackage` (71) and the orchestrator's
  `buildDepositStateInit` import (12) are therefore never executed.
- `server/deposit/GameEscrowDeploymentAuthorizationAutomation.js` (8 refs) —
  the "PaymentSession created → DeploymentAuthorization VALID → deploy
  GameEscrow" automation. **Not imported by app.js**; imported only by
  `server/tests/gameEscrowOnlyPlayerPayment.r18s63.test.js`. Never runs.
- `server/deposit/EntryDeploymentAuthorizationAutomation.js` (6 refs) —
  **wired** (app.js:1608–1615) and subscribed to
  `DEPOSIT_PACKAGE_PUBLISHED` (71–74), but since that event has no producer
  (bullet 1), its handler (78–109) never fires.
- `server/deposit/DeploymentAuthorization.js` `fromGameEscrowReady` (140),
  `DeploymentAuthorizationCoordinator.createFromGameEscrowReady` (116),
  `deploymentAuthorizationValidation.assertCanCreateGameEscrowDeploymentAuthorization`
  (251) — authorization machinery whose only production triggers are the
  automations above (one unwired, one event-starved). Emitted
  `DEPLOY_AUTHORIZATION_VALID` (`DeploymentAuthorizationCoordinator.js:158`)
  has no production subscriber except the uninstantiated
  `GameContractManager` (245).
- `server/payment/ton/buildDepositStateInit.js` (10) and
  `server/payment/ton/verifyDepositArtifact.js` — DepositContract StateInit
  builder + artifact verifier. Production importers:
  `DepositOrchestrator` (not initialized),
  `DepositActivationVerificationCoordinator` (lines 21, 29),
  `RealTonDepositBlockchainSource` (19, 21), plus testnet scripts
  (`depositTestnetDeploy.js`, `depositTestnetFixture.js`). Active use is
  limited to verification inside the dormant deposit chain.
- `server/deposit/projectDepositForPlayer.js` (10) — projects a frozen
  `depositPackage` for a player; called only from `RoomLobbyBridge`
  deposit-delivery paths (7020) and the reconnect restore projection
  (6920–6983). Purely informational; never creates a transaction.
- `server/deposit/resolveDepositOrchestrationFinancials.js` (1) —
  DepositContract stakes/fees resolution; used by the uninitialized
  orchestrator.
- `server/socket/RoomLobbyBridge.js` (9 refs) — subscriptions to
  `DEPOSIT_PACKAGE_PUBLISHED` / `DEPOSIT_SEAT_FUNDED` /
  `DEPOSIT_FULL_ONCHAIN` (911–945) → `_deliverDepositPackagePublished`
  (6985–7044) → socket `LOBBY_SERVER_EVENTS.DEPOSIT_PACKAGE_PUBLISHED`
  (6925, 7036); `lobbyProtocol.js:102`. Dormant while no deposit
  watch/session exists (see §8 for the persisted-data exception).
- Client deposit plumbing (informational mirror only):
  `client/src/socket/socketEvents.js` (`DEPOSIT_PACKAGE_PUBLISHED` name),
  `SocketSyncLayer.js:390,600,772` (bind/handler; comment "informational
  mirror"), `EngineBridge.js:257–261`, `AuthoritativeSessionContext.jsx:378–385`
  (dispatches `DEPOSIT_PACKAGE_PUBLISHED` — "mirror only"). The store mirror
  is never used as a payment source (§5.4);
  `page4PaymentPhase.hasLegacyDepositPackage` (30–57) is **dead code** —
  defined but never called anywhere in `client/`.
- `client/src/payment/buildDepositDeploymentTransaction.test.js` (25),
  `buildFundDepositTransaction.test.js` (1),
  `page4DepositActivationHandoff.test.js` (5),
  `staleDepositGameStart.r18s16.test.js` (7) — legacy-phase regression tests.

## 8. Potentially Dangerous Findings

No finding can redirect, block, duplicate, or alter Room Wallet funds. The
items below are the only remaining links with *any* runtime reach, ranked by
attention level. Nothing here is a payment-path hazard today.

### D-1 (Medium, operational) — GameEscrow artifact is a live boot dependency

- `server/app.js:4622–4660` + Testnet default `gameEscrowMode = "game"`
  (`server/config/gameEscrowMode.js:21–30`) make
  `GameEscrow.code.boc` presence + loadability a **fail-closed startup
  requirement on Testnet**, even though no GameEscrow payment code runs.
- Effect if the artifact is deleted/corrupted (e.g., by a future cleanup):
  server refuses to boot. No fund risk; availability risk only.
- The architecture docs (`docs/operations/Mainnet-Launch-Checklist.md`,
  `R7.69D` audit) deliberately keep this rollback/verification gate, so it is
  **not** classified as a defect — but any future "remove GameEscrow files"
  task must remove this gate in the same approved change, or Testnet breaks.

### D-2 (Low→Medium, historical data) — deposit-era recovery reactivation

- `server/recovery/TonFinancialRecovery.js` restores durable DepositSessions
  (`_restoreDepositSessions`, 1029) and re-arms DepositMonitor watches
  (`_restoreDepositMonitorWatches`, 1083–1119 → `DepositMonitor.restoreActiveWatches`,
  which internally calls `startWatching`, `DepositMonitor.js:351`).
  `DepositActivationVerificationCoordinator` (898–906) can also
  `authorizeVerifiedWatch` + `startWatching` for restored sessions.
- If **persisted deposit-era records** exist in `TonFinancialPersistence`
  (from runs before the Room Wallet cutover), a restart can re-arm chain
  polls on old `DepositContract` addresses. Observed funding would emit
  `DEPOSIT_SEAT_FUNDED` / `DEPOSIT_FULL_ONCHAIN` (`DepositMonitor.js:460,469`)
  → `RoomLobbyBridge` delivers a stale `DEPOSIT_PACKAGE_PUBLISHED` projection
  (informational mirror) → `DepositFullAuthorizationAutomation` /
  `EntryDeploymentAuthorizationAutomation` could create a
  `DEPLOY_AUTHORIZATION_VALID` record.
- Hard limits: no consumer of `DEPLOY_AUTHORIZATION_VALID` exists
  (`GameContractManager` absent); no code path from deposit observations to
  `PaymentSessionManager`, `GameStartAuthorization`,
  `RoomWalletSettlementRouter`, or refunds. Worst case is log noise and a
  stale informational UI mirror on a reconnecting client.
- Watch authorization is gated (`DepositMonitor.js:100–134` requires
  `authorizeVerifiedWatch` first; watches for dead rooms are pruned, 253–275).

### D-3 (Low, naming hazard) — `GAME_ESCROW_STAKE_CONFIRMED` on the live path

- Emitted for Room Wallet payments (`BlockchainMonitor.js:2886–2908`),
  consumed only by the archive manager. Hazard is semantic: a future module
  subscribing to this name could mistake Room Wallet transfers for GameEscrow
  STAKE facts. Currently safe by design and documented.

### D-4 (Low, latent legacy branch) — `failSession` escrow unwind branch

- `PaymentSessionManager.js:2202–2245` calls
  `this._gameContractManager.requestPartialPaymentEscrowUnwind(...)` without
  optional chaining *inside* the branch, but the branch condition
  (2156–2159) requires both `!intake` and the manager method to exist, so the
  call is unreachable. If someone later flips
  `isRoomWalletOnlyFinancialPath` to `false` without re-wiring
  `gameContractManager`, this branch would throw. Guarded today; flagged for
  future-mode awareness only.

### D-5 (None observed) — explicitly checked and cleared

- No GameEscrow/DepositContract reference exists in
  `GameStartAuthorization.js`, `RoomWalletIncomingObserver.js` (comments
  only), `RoomWalletSettlementRouter`, `RoomWalletSettlementAdapter`, or any
  refund path. `PaymentEngine` (constructed at app.js:5013) contains zero
  GameEscrow/DepositContract references and is the retired v4 demonstration
  engine. The `.kilo/worktrees/powerful-trunk` parallel checkout contains its
  own copies but is not executed from the main tree.

## 9. Lifecycle Flow — Per-Flow Trace (task item 4)

### 9.1 Page4 payment (client)

1. `Page4Payment.jsx` "CONFIRM IN TELEGRAM WALLET" →
   `resolvePlayerPaymentDestination` (`page4PaymentPhase.js:63`) →
   `paymentSession.roomWalletAddress` only.
2. `buildEntryPaymentTransaction` (`buildEntryPaymentTransaction.js:125`) —
   deploy/fund forced off; `depositPackage` / `gameEscrowAddress` / STAKE
   payload builders **throw "disabled"**; plain transfer built.
3. `toTonConnectSendTransactionRequest` (88–120) whitelists
   `validUntil`/`messages[]` only.
4. GameEscrow/DepositPackage presence in this flow: names only (§5.4);
   **no executable old-architecture code**. The only DepositPackage data a
   client can receive is the informational mirror socket event (§7.4), which
   no payment code reads.

### 9.2 PaymentSession (server)

1. `PAYMENT_CONNECTION_READY` → `createAndRequest` (563) →
   `createPaymentSession` (417): contract gate skipped (no contract object
   exists; 408–427), Room Wallet address fail-closed (508–522),
   `_activatePaymentRequests(session, { contractAddress: roomWalletAddress })`
   (546–549) — participants get `paymentDestination = roomWalletAddress`,
   `contractAddress = null` (2605–2606); per-room blockchain watches are
   registered **only when intake is disabled** (2628–2632); the Room Wallet
   intake observer (`RoomWalletIncomingObserver`) polls instead.
2. Confirmation: `PAYMENT_TRANSACTION_CONFIRMED` / `PAYMENT_BLOCKCHAIN_CONFIRMED`
   → participant `PAYMENT_CONFIRMED` → `_maybeCompleteSession` (2799–2812) →
   `FULLY_PAID` → `PAYMENT_SESSION_COMPLETED`.
3. GameEscrow involvement: zero executable (sync early-returns; handlers
   unsubscribed; §7.2).

### 9.3 GAME_START_AUTHORIZED / GAME_INITIALIZED

1. `GameStartAuthorization` validates the **Room Wallet ledger**:
   `roomWalletLedgerRegistry.listPlayerPayments(gameId)` must cover every
   participant (462–492), else `room_wallet_ledger_incomplete`.
2. `_authorizeAndBootstrap` (496) → audit records + emit
   `EVENT_TYPES.GAME_START_AUTHORIZED` (525) → `GAME_INITIALIZING` (540+) →
   server-authoritative bootstrap → `GAME_INITIALIZED` (gameplay authority).
3. `RoomLobbyBridge` subscribes `GAME_START_AUTHORIZED` (875–882) and
   delivers the socket event (7079–7095).
4. GameEscrow involvement: **none** — the file has zero escrow/contract
   references; no DeploymentAuthorization or contract-readiness input exists
   in this path.

### 9.4 Room Wallet refund (pre-GAME_INITIALIZED)

1. Triggers: `setup_expired` / `creator_left` / `payment_failed` /
   `payment_timeout` → `PaymentSessionManager.failSession` (2076).
2. Gate: `refundableFullyPaidBeforeGameInit` (2110–2116) allows FULLY_PAID
   refund for `setup_expired` / `creator_left`;
   `needsRoomWalletRefund` (2148–2152) →
   `_requestRoomWalletPartialPaymentRefund` (1961) →
   `RoomWalletSettlementAdapter.refundPayments` →
   `_finalizePartialPaymentUnwind` → `CANCELLED` + `PAYMENT_SESSION_FAILED`.
3. GameEscrow involvement: zero. The legacy `needsEscrowUnwind` branch
   (2202–2245) is disabled by intake mode (§7.2). The escrow-era helper
   `sessionNeedsEscrowUnwind` (`partialPaymentEscrowUnwind.js:7`) is still
   imported and used (34–35, 2151) but with Room-Wallet semantics (it simply
   detects unrefunded confirmed funds; its name is historical).

### 9.5 Normal settlement (winner payout)

1. `WinnerEngine` → `WINNER_DETERMINED` → `ContractSettlementManager`
   (`initialize()` 236–244) → settlement session → **settlementAdapter =
   RoomWalletSettlementRouter** sends winner/owner payouts from the Room
   Wallet (`_isRoomWalletSettlementActive() === true` throughout).
2. Every GameEscrow settlement branch is behind `!_isRoomWalletSettlementActive()`
   or `escrowMode === GAME_ESCROW_MODE_GAME` with a real contract object —
   both false/unavailable (§7.3). `GAME_ESCROW_SETTLEMENT_VERIFIED/REJECTED`
   are not even subscribed; `BlockchainMonitor.watchGameEscrowSettlement`
   never registers.
3. `GameplayLifecycle.configureSettlementTeardownGate` holds `GAME_DESTROYED`
   until settlement terminal — via `contractSettlementManager` only.

### 9.6 Recovery / restore (server restart)

1. `TonFinancialRecovery.recover()` → `recoverPayments()` →
   `PaymentSessionManager.restorePaymentSessions()` (716):
   - terminal skip now honours the in-progress Room-Wallet refund-recovery
     gate (`refundableRestoredFullyPaid`, 761–770) — the working-tree
     modification under review by the 2026-09-27 gap report;
   - `_finishPaymentSessionRestore` → GameEscrow chain sync via
     `syncFromGameEscrow` (946) — early-return no-op in intake mode (977–986);
     legacy watches only when `!intake` (903–911).
2. Deposit-era restore: `_restoreDepositSessions` (1029) +
   `_restoreDepositMonitorWatches` (1083) — reactivates only persisted
   historical deposit sessions/watches (§8 D-2).
3. Gameplay recovery (`RecoveryCheckpointManager` 1797–1813,
   `RecoveryOrchestrator` 1843–1855) — constructed **without**
   `gameContractManager`; `RecoveryCheckpointManager.js:461`
   `getContractByGameId` is an optional-chain no-op. Fail-closed financial
   reconciliation never consults GameEscrow in intake mode.

## 10. Ownership Boundaries

The current architecture preserves domain ownership exactly:

- **Payment intake authority**: `PaymentSessionManager` (Room Wallet intake
  mode) + `BlockchainMonitor` (observation) + `RoomWalletIncomingObserver`.
  The GameEscrow read helpers inside `BlockchainMonitor`
  (`readGameEscrowPaymentState` 1240, `readGameEscrowCancelState` 1327,
  `watchGameEscrowRefunds` 859) remain **owned by the dormant legacy domain** —
  called only from unreachable code (§7.2, §7.3).
- **Settlement authority**: `ContractSettlementManager` with
  `RoomWalletSettlementRouter` adapter. Legacy GameEscrow settlement state
  machine (SETTLE/payout-proof branches) remains as guarded dead code.
- **Refund authority**: `PaymentSessionManager.failSession` →
  `RoomWalletSettlementAdapter` (intake) — legacy
  `GameContractManager.requestPartialPaymentEscrowUnwind` route disabled.
- **Game-start authority**: `GameStartAuthorization` — Room Wallet ledger
  only; no deposit/escrow/authorization input.
- **Recovery authority**: `TonFinancialRecovery` — payments restore is
  Room-Wallet-aware; deposit restore is quarantined historical machinery.
- No parallel implementations were created and none were removed during this
  analysis.

## 11. Risk Summary (classified)

- **Critical**: none.
- **High**: none.
- **Medium**: D-1 (artifact gate is a Testnet boot dependency — operational,
  not financial); D-2 (deposit-era recovery reactivation from persisted
  legacy data — informational reach only, no financial reach).
- **Low**: D-3 (legacy event name on live path — semantic hazard only);
  D-4 (latent `failSession` escrow branch — unreachable, future-mode hazard
  only).
- **Informational**: legacy naming in active helpers
  (`isGameEscrowOnlyPlayerPayment`, `canStakeGameEscrow`,
  `GAMEESCROW_STAKE` phase, `sessionNeedsEscrowUnwind`,
  `payment.waitingGameEscrow`, "R7.70C10 GameEscrow STAKE body" comment) —
  none changes behaviour; documented here to prevent future misreading.

## 12. Recommendations (documentation only — NOT implemented)

1. Keep §6 items (artifacts, archive subscription, event names, contract
   sources, negative tests, docs) until an explicitly approved cleanup stage.
2. If a future stage removes GameEscrow files, remove
   `server/app.js:4622–4660` verification and the `gameEscrowMode`
   Testnet default **in the same approved change** (D-1).
3. Consider (future, approved) an explicit comment at
   `BlockchainMonitor.js:2886` stating that the event name is historical and
   the payload is a Room Wallet observation (reduces D-3).
4. Consider quarantining or versioning persisted `DEPOSIT_SESSION` /
   `DEPLOYMENT_AUTHORIZATION` records so recovery can distinguish
   pre-cutover historical data (D-2) — analysis first, no code changes now.
5. Do not "simplify" `PaymentSessionManager` by deleting the orphaned
   escrow handlers/branches without an architecture review: they document the
   non-intake rollback path (mainnet `v4` doctrine) and are currently
   harmless.

## 13. Final Conclusion (interference verdict)

**Can any remaining GameEscrow / DepositContract / DepositPackage reference
interfere with the current Room Wallet flow? — NO.**

- Page4 payment: client builds Room-Wallet-only plain transfers; old
  builders throw "disabled"; old addresses unreachable.
- PaymentSession: fail-closed on `roomWalletAddress`; legacy activation
  disabled; escrow sync/watch paths short-circuit in intake mode.
- GAME_START_AUTHORIZED / GAME_INITIALIZED: authorized from the Room Wallet
  ledger only; zero escrow input.
- Room Wallet refund: Room Wallet settlement adapter only; the escrow unwind
  branch is double-guarded and unreachable.
- Normal settlement: Room Wallet router is the only active settlement path;
  GameEscrow settlement branches are unsubscribed/guarded; every
  `gameContractManager` call site is a no-op in production.
- Recovery/restore: payment restore is Room-Wallet-aware; the only old
  machinery that can run is deposit-era restoration over historical persisted
  data, which is informational and financially inert.
- The active GameEscrow-named code that *does* run (startup artifact
  verification, `GAME_ESCROW_STAKE_CONFIRMED` archival, mode
  config/diagnostics, legacy-named client helpers) performs no payment,
  routing, gating, or settlement function.

The remaining references fall into: (A) evidence/financial-record usage that
must remain (§6); (B) inactive/legacy code not reached (§7); (C) potentially
active dependencies — limited to D-1/D-2 (§8) — none of which can interfere
with Room Wallet financial truth.

## 14. Changes Made

No source files modified. No files deleted. Nothing refactored. No abandoned
payment architecture restored. No Git commit, no Git push.

Only this report was created:
`AI_CONTEXT/CLINE_REPORTS/2026-09-27_gameescrow_depositcontract_remaining_links_analysis.md`

Pre-existing working-tree state (untouched by this task, present before the
analysis and unchanged by it):

```
 M server/gameplay/PaymentSessionManager.js
?? AI_CONTEXT/CLINE_REPORTS/2026-09-27_payment_session_restore_room_wallet_refund_gap.md
?? server/tests/restoreRoomWalletRefund.test.js
```










