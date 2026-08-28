# R18-S15 — Server GameEscrow Lifecycle to Page5 E2E

Date: 2026-08-28  
Task: Continue the server-side E2E from R18-S14 `DeploymentAuthorization VALID` through the existing GameEscrow / payment / game-start path to the authoritative Page5-ready state.  
Classification: **R18_S15_PARTIAL**

This report has four historical layers plus the Page5 production-lobby continuations below. **Do not conflate them.**

1. **Investigation (earlier S15 session)** — proved the missing production caller after `DEPLOY_AUTHORIZATION_VALID`. No source change. No GameEscrow transaction.
2. **Implementation** — wired that caller into existing `GameContractManager`. Commit `efb394b`. Focused tests pass.
3. **LIVE TESTNET execution** — real TESTNET Deposit FULL → VALID → production GCM handoff → real GameEscrow deploy + INIT_GAME + OPEN_PAYMENTS. First live runner stopped because it called `get_contract_state` (exit_code 11).
4. **LIVE TESTNET continuation (getter / STAKE)** — proved exit 11 is a verification-path mismatch, not a failed GameEscrow. Same contract reached `PAYMENTS_OPEN` then 3× STAKE, on-chain `paidMask=7` / `READY`. Page5 not reached (no production lobby PaymentSession on this stack).
5. **LIVE TESTNET — production lobby / PaymentSession / Page5 continuation** — real `WheelWinApplication` (`app.js`) lobby room. Stopped after on-chain Deposit `paidMask=7` because production never polls `DepositMonitor`. See the new section below.

Page4 and Page5 were not modified. DepositContract logic and Deposit economic parameters were not changed. Authorization consume remains inside `_beginDeploy`.

---

# Implementation continuation — production VALID → createContractRequest

## 1. Starting HEAD

```
9707666c112fc54755f9b53ac0a17889bee37cad
9707666 (HEAD -> main, origin/main) R18-S11 recovery: restore Page4 Deposit integration
```

Branch: `main`.

## 2. Working tree state

Dirty with the same pre-existing untracked reports, probes, and sample banners as the investigation session. No unexpected production diffs at start. This session changed only the files listed in §11.

## 3. Exact production integration point found

**VERIFIED BY SOURCE**

`DEPLOY_AUTHORIZATION_VALID` is emitted by `DeploymentAuthorizationCoordinator.markValid()` with payload:

```text
authorizationId, roomId, gameId, depositId, status, authorizationHash
```

`GameContractManager.createContractRequest(roomId, { gameId, correlationId })` is the existing create entry. Network is resolved inside GCM (`_resolveTonNetwork()` / constructor `tonNetwork` / adapter config). Consume is **not** here; it remains `consumeValidForDeploy` in `_beginDeployAuthorized`.

`DepositFullAuthorizationAutomation` was **not** redesigned. It still only creates/marks VALID. The handoff is a new GCM event subscription, matching other GCM `_subscribe` handlers and the R17.9L.18 reservation that payment events are not deploy authority.

Application composition (`app.js`): GCM `initialize()` runs before Deposit automation. Live `markValid` therefore reaches an already-subscribed GCM. Recovery of already-VALID rows still does **not** re-emit VALID (`TonFinancialRecovery` restores without deploying). That recovery gap is unchanged and is the next server-side follow-up if a process restarts between VALID and create.

## 4. Exact code change

`GameContractManager.initialize()` now subscribes to `EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID` and calls `_handleDeploymentAuthorizationValid`.

The handler:

* requires `roomId` + `gameId` from the event;
* fail-closes unless `getByRoomAndGame` returns status `VALID`;
* fail-closes on network mismatch when both sides are set;
* calls existing `createContractRequest` (idempotent if a contract already exists);
* does **not** call `consumeValidForDeploy`;
* does **not** call `TonGameContractAdapter.deployContract` directly;
* does **not** fabricate lifecycle events.

## 5. Why this is the correct existing architectural handoff

```text
DEPOSIT_FULL
    → DepositFullAuthorizationAutomation (unchanged)
    → DEPLOY_AUTHORIZATION_VALID
    → GameContractManager._handleDeploymentAuthorizationValid   [NEW]
    → createContractRequest                                     [EXISTING]
    → _scheduleCreated → _beginDeploy
    → consumeValidForDeploy                                     [EXISTING GATE]
    → adapter.deploy → INIT_GAME → OPEN_PAYMENTS
```

Payment events remain non-triggers (R17.9L.18). Duplicate VALID after CONSUMED is ignored. Duplicate VALID while a contract exists hits `createContractRequest` idempotency.

## 6. Tests executed and results

**VERIFIED BY AUTOMATED TEST**

| File | Result |
|------|--------|
| `tests/gameContract.deployAuthorizationHandoff.r18s15.test.js` (A/B/C/D) | 6 pass |
| `tests/gameContract.legacyDeployTriggerIsolation.r179l18.test.js` | 7 pass |
| `tests/gameContract.deploymentAuthorizationGate.r179l5b.test.js` | 6 pass |
| `tests/depositFull.deploymentAuthorizationAutomation.r179l6.test.js` | 6 pass |
| `tests/depositBackendE2E.r179l19.test.js` | 24 pass |

- **A** VALID → `createContractRequest` with correct room/game, then existing consume+mocked deploy.
- **B** forged VALID and CREATED-only auth do not create/deploy.
- **C** duplicate VALID does not create a second contract.
- **D** payment events still do not deploy.

L.19 tests that previously asserted “VALID, no auto Game deploy” were updated to the new production handoff. Isolation at 0/1/2 funded seats is unchanged.

## 7. TESTNET execution

**NOT VERIFIED** as a GameEscrow transaction in this implementation session.

Preflight **VERIFIED BY SOURCE / env flags only** (secrets not printed):

```text
TON_NETWORK=testnet
endpointLooksMainnet=false
oracleSet=true
deployerConfigured=true
```

No MAINNET endpoint selected. No `sendBoc` / GameEscrow deploy / STAKE broadcast was sent.

Why live GameEscrow was not executed here:

* The S14 VALID authorization is still absent from durable `server/data/ton-financial`. It was **not** injected.
* `server/tests/testnet/r179l25/` still uses a **GCM stop stub**. That harness is Deposit isolation, not the production GCM subscriber. Re-running it would spend more FundSeat TON and still not hit this wiring.
* A real production run needs a live room (3 players, wallets, Deposit FULL) on a server process that includes this GCM change. That room was not created in this session.

## 8. Exact GameEscrow / payment / game-start / Page5 state reached

| State | Evidence class | Result |
|--------|----------------|--------|
| Production VALID → createContractRequest | AUTOMATED TEST | reached (mocked adapter) |
| GameEscrow deployed (TESTNET) | NOT VERIFIED | not executed |
| INIT_GAME / OPEN_PAYMENTS / STAKE | NOT VERIFIED | not executed |
| PAYMENT_SESSION_COMPLETED | NOT VERIFIED | not executed |
| GAME_START_AUTHORIZED | NOT VERIFIED | not executed |
| GAME_START_BOOTSTRAP_READY | NOT VERIFIED | not executed |
| ENTRY_PAYMENT_COMPLETED | NOT VERIFIED | not executed |
| OPEN_PAGE5 | NOT VERIFIED | not executed |

S14 DepositContract on TESTNET remains the last **real chain** financial state (`FULL` / `paidMask=7`). That is historical S14 evidence, not a new S15 GameEscrow run.

## 9. Blocker

**BLOCKED** for live GameEscrow/Page5: no live production Deposit session in this process, and L25 does not host the new GCM subscriber.

Not a defect in `createContractRequest` or `consumeValidForDeploy`.

Secondary documented gap (not fixed here): process restart after VALID is persisted but before create — recovery restores VALID **without** re-emitting `DEPLOY_AUTHORIZATION_VALID`, so the new handler will not fire until a new VALID event or an explicit sync is added.

## 10. Exact stopping point

```text
DEPLOY_AUTHORIZATION_VALID
        ↓
GameContractManager._handleDeploymentAuthorizationValid
        ↓
createContractRequest                 [wired + unit/E2E proven]
        ↓
[live TESTNET GameEscrow deploy]     STOP — no live production room this session
```

## 11. Changed files

* `server/gameplay/GameContractManager.js`
* `server/tests/gameContract.deployAuthorizationHandoff.r18s15.test.js` (new)
* `server/tests/gameContract.legacyDeployTriggerIsolation.r179l18.test.js`
* `server/tests/depositBackendE2E.r179l19.test.js`
* `server/tests/helpers/depositBackendE2EHarness.r179l19.js`
* `AI_CONTEXT/CLINE_REPORTS/2026-08-28_r18_s15_server_gameescrow_to_page5_e2e_report.md`

## 12. Commit SHA

```
efb394b1cba333b23850042243b831f8af54d5f6
efb394b R18-S15 wire deployment authorization to GameContractManager
```

## 13. Final Git state

```
HEAD: efb394b (main)
message: R18-S15 wire deployment authorization to GameContractManager
```

Pushed to `origin/main`. Working tree still contains unrelated pre-existing untracked/modified user files; those were not part of this commit.

## 14. Single next server-side action

**Done in the LIVE TESTNET section below.** The remaining next action is to diagnose GameEscrow `get_contract_state` `exit_code: 11` after a successful deploy (see live §25). Do **not** reuse `dep_f61f4bcc` or `dep_88b2adae`.

Optional follow-up only if restart-between-VALID-and-create is required: sync VALID authorizations into GCM after `TonFinancialRecovery` without moving consume out of `_beginDeploy`.

---

# LIVE TESTNET execution — GameEscrow deployment continuation

Date: 2026-08-28 (same calendar day, later session)  
Classification remains **R18_S15_PARTIAL** (handoff + real GameEscrow deploy proven; Page5 not reached).

This section is the live TESTNET run. It does **not** rewrite S14 FundSeat hashes or the implementation-session “not executed” rows as if they were this run.

## 1. Starting HEAD

```
a7d5fe971cc165a547c5549df77a8990d09c1ba5
a7d5fe9 (HEAD -> main, origin/main) docs: record R18-S15 commit SHA
efb394b R18-S15 wire deployment authorization to GameContractManager
```

Wiring commit `efb394b` is present. Branch `main`.

## 2. Working tree state

Production paths `server/gameplay/GameContractManager.js`, `server/app.js`, `client/src` were clean. Untracked live runners used for this session (not committed):

* `server/scripts/_r18s15_live_gameescrow.mjs`
* `server/scripts/_r18s15_resume_escrow.mjs`

L25 GCM **stub was not used as GameContractManager**. Real `GameContractManager` + `TonGameContractAdapter` were attached to the same event bus as the existing Deposit coordinators / player FundSeat helpers.

## 3. TESTNET preflight

**VERIFIED BY SERVER LOG**

```
TON_NETWORK=testnet
tonEndpoint=https://testnet.toncenter.com/api/v2/jsonRPC
deployMode=live
gameEscrowMode=game
oracleConfigured=true
```

No MAINNET endpoint. `TON_DEPLOY_MODE` was already `live` (no override printed).

Balances (public):

| Role | Address | Balance |
|------|---------|---------|
| GameEscrow deployer/oracle | `EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ` | 4.905272529 TON (min 0.2) |
| Player seat 0 | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` | 19.848009 TON |
| Player seat 1 | `EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp` | 28.025463 TON |
| Player seat 2 | `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` | 23.390432 TON |

S14 authorization `dep_f61f4bcc-…` was **not** reused.

## 4. Fresh room/session identity

**VERIFIED BY SERVER LOG**

```
roomId=room-l25-1787938991293
gameId=game-l25-1787938991293
depositId=dep_88b2adae-b700-4780-83b0-8bf385cfe3e6
DepositContract=EQBPDVeu6XpoAj1FQ8dbJYNhiges32RvR7G3JwsxPTho4tuM
authorizationId=dauth_94df0727-6433-421b-9574-57b3e8a9a56c
```

Creator/seat: seat 0 player0 deployed DepositContract (same production Creator ≡ seat 0 rule). Room fixtures used admission order `p0,p1,p2`.

## 5. Deposit lifecycle result

**VERIFIED BY REAL TESTNET TRANSACTION** + **SERVER LOG**

| Step | Evidence |
|------|----------|
| Orchestration | `WAITING_FOR_PLAYER_DEPLOYMENT` → package address match |
| Deposit deploy sender | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` |
| Deposit deploy tx | `HXmyVTLlz56qZBCXxr1ciPHvzC4awKeE9s5v7lIlVQs=` |
| Deposit deploy bocHash | `3567a83fec150e3a20311869307023f67b59f15562329bb630f180be8317c4a0` |
| Activation | watch started (`phaseD=PASS`) |
| FundSeat amounts | 11000000 nanoTON each (unchanged Deposit economics) |
| FundSeat boc hashes | seat0 `fd6df76e647633ad86503562d330ebdc4a6c8e8b7e787d1f584d7acc927a3c3a`; seat1 `7ec2d09681f61d5827fc61dd583969279246b5e70a05405f4e1e17adaf7d88d7`; seat2 `c37f348e235950eb574e20f6e20c7427636a66846f2fa89e4fa4efbae3796690` |
| Server | `depositFullOnChain=true` then `DEPLOY_AUTHORIZATION_VALID` |

(FundSeat `transactionHash` fields from TonCenter sendBoc were null as in S14; confirmation was via monitor FULL.)

## 6. DEPLOY_AUTHORIZATION_VALID runtime evidence

**VERIFIED BY SERVER LOG** (not source inspection)

```
event type=DEPLOY_AUTHORIZATION_VALID
roomId=room-l25-1787938991293
gameId=game-l25-1787938991293
status=VALID
```

## 7. `_handleDeploymentAuthorizationValid` runtime evidence

**VERIFIED BY SERVER LOG**

```
handlerCalls=1
```

Wrapped instance method logged one call for this room/game immediately after VALID.

## 8. `createContractRequest` runtime evidence

**VERIFIED BY SERVER LOG**

```
createCalls=1
createCallArgs=["room-l25-1787938991293",{ gameId:"game-l25-1787938991293", correlationId:"dauth_94df0727-6433-421b-9574-57b3e8a9a56c" }]
CONTRACT_CREATED → CREATING → READY_FOR_BLOCKCHAIN
contractId=contract_b19bdc62-5c87-4c4a-bb47-86076e99d7f8
```

## 9. Authorization consumption evidence

**VERIFIED BY SERVER LOG**

```
event type=DEPLOY_AUTHORIZATION_CONSUMED
consumeCalls=1
authStatusAfterDeploy=CONSUMED
authorizationId=dauth_94df0727-6433-421b-9574-57b3e8a9a56c
```

Consume happened inside existing `_beginDeploy` **before** adapter spend (`BEGIN CONTRACT DEPLOY` CurrentState=DEPLOYING, then `TonGameContractAdapter.deploy`).

## 10. GameEscrow deployment transaction

**VERIFIED BY REAL TESTNET TRANSACTION** + **SERVER LOG**

```
network=testnet
endpoint=https://testnet.toncenter.com/api/v2/jsonRPC
deploymentTxId=ej7Aj9SR8glUCrelYsk8ObTiiPEvhE75CuP9Yy+sA5Y=
deploy bocHash=5f8cbfdbb81839b07a192ee1420e13a4cfa2c8f72afa932a0307776199d2302c
deployer=EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ
valueTon=0.022
seqno=297 confirmedSeqno=298
codeHash=2f25daf3d8b76390697b97b79258c6bb9a6d1172d8c104ff2ea8c5c52ddcbeaa
  (matches server/payment/ton/artifacts/GameEscrow.code.json)
activation.ok=true
adapter.deploy ok=true
```

## 11. GameEscrow contract address

```
EQBz6JvvkNk9ct3X6m8C8nKiWdUnm7J2aebMoDdcw692jrLv
```

Associated with `room-l25-1787938991293` / `game-l25-1787938991293` / `dauth_94df0727-…`.

## 12. INIT_GAME result

**VERIFIED BY REAL TESTNET TRANSACTION** (resume process; first live process was killed after deploy while INIT_GAME sendBoc was in flight)

```
txId=8OBZzOlvTS436dkE+nd8GDfys4+NZPNa1+7yM3nt6bA=
ok=true
seqno=299 confirmed 300
```

**On-chain getter after INIT:** `get_contract_state` **exit_code 11**. Status string therefore **NOT VERIFIED**.

## 13. OPEN_PAYMENTS result

**VERIFIED BY REAL TESTNET TRANSACTION** (oracle broadcast)

```
txId=WEM0RHnNAxjcqdCjiNTHvDDqntOwu0gGIxZ8s/YFq4Q=
ok=true
seqno=300 confirmed 301
```

**On-chain getter after OPEN:** still `get_contract_state` **exit_code 11**. `PAYMENTS_OPEN` **NOT VERIFIED**. STAKE was **not** sent.

## 14. STAKE transaction #1

**NOT VERIFIED** — not sent. Stopped because getters could not confirm PAYMENTS_OPEN.

## 15. STAKE transaction #2

**NOT VERIFIED** — not sent.

## 16. STAKE transaction #3

**NOT VERIFIED** — not sent.

## 17. On-chain paidMask

**NOT VERIFIED** (`get_paid_mask` / `get_contract_state` exit 11). Account was `active` with balance `41103787` nanoTON at resume start.

## 18. PAYMENT_SESSION_COMPLETED

**NOT VERIFIED** — not reached. Live stack did not include RoomLobbyBridge PaymentSession → Page5 path.

## 19. GAME_START_AUTHORIZED

**NOT VERIFIED**

## 20. GAME_START_BOOTSTRAP_READY

**NOT VERIFIED**

## 21. ENTRY_PAYMENT_COMPLETED

**NOT VERIFIED**

## 22. OPEN_PAGE5

**NOT VERIFIED**

## 23. Exact final authoritative server state

Last **runtime** GCM snapshot before the first process exited: `DEPLOYING` with `contractAddress` already set (runner wait matched address too early). Authorization **CONSUMED**. Adapter deploy **ok**.

Last **on-chain** evidence: GameEscrow account **active**; INIT_GAME and OPEN_PAYMENTS oracle txs confirmed; getters **exit_code 11**.

## 24. Exact stopping point

```text
DEPOSIT_FULL
    ↓
DEPLOY_AUTHORIZATION_VALID                 [runtime]
    ↓
_handleDeploymentAuthorizationValid        [runtime, 1 call]
    ↓
createContractRequest                      [runtime, 1 call]
    ↓
consumeValidForDeploy                      [runtime, CONSUMED]
    ↓
TonGameContractAdapter.deploy              [TESTNET tx ej7Aj9SR…]
    ↓
GameEscrow address assigned + ACTIVE
    ↓
INIT_GAME tx 8OBZzOlv…                     [TESTNET]
    ↓
OPEN_PAYMENTS tx WEM0RHnN…                 [TESTNET]
    ↓
get_contract_state exit_code 11            STOP
```

STAKE / paidMask / PAYMENT_SESSION_COMPLETED / GAME_START_* / ENTRY_PAYMENT_COMPLETED / OPEN_PAGE5 were not reached.

## 25. Blockers

```
LAST VERIFIED STATE
    GameEscrow DEPLOYED (TESTNET) + INIT_GAME/OPEN_PAYMENTS oracle broadcasts confirmed
EXACT NEXT EXPECTED STATE
    on-chain PAYMENTS_OPEN (or READY) then 3 × player STAKE
EXACT OPERATION THAT FAILED
    TonGameContractAdapter.getContractState / runGetMethod get_contract_state
EXACT ERROR
    Unable to execute get method. Got exit_code: 11
RELEVANT FILE / FUNCTION
    server/payment/TonGameContractAdapter.js getContractState
    GameEscrow getters on EQBz6JvvkNk9ct3X6m8C8nKiWdUnm7J2aebMoDdcw692jrLv
RUNTIME EVIDENCE
    account state=active; deploy/init/open sendBoc 200; getter exit 11
WHETHER THE BLOCKER IS
    TESTNET state / contract getter ABI after this deploy
    contributing live-runner issues (not production source changes):
      - wait predicate treated contractAddress as terminal and process.exit'd during INIT_GAME
      - OwnerConfiguration example wallet is ZERO (EQAAA…AM9c), frozen into snapshot owner
```

No speculative FunC/ABI redesign was performed.

## 26. Whether source code changed

**No production source change** in this live session. `GameContractManager.js` remains `efb394b`. Client untouched.

Untracked live scripts only.

## 27. Commit SHA if source changed

**N/A.** HEAD remains `a7d5fe9`. No push.

---

# LIVE TESTNET continuation — `get_contract_state` exit 11 and STAKE

Date: 2026-08-28  
Task: Resolve the GameEscrow `get_contract_state` exit_code 11 blocker on the already-deployed TESTNET contract and continue the same session toward Page5.  
Classification: **R18_S15_PARTIAL**

This section is the continuation of layer 3. It does **not** rewrite S14 evidence or the earlier S15 investigation. Same live GameEscrow:

```
EQBz6JvvkNk9ct3X6m8C8nKiWdUnm7J2aebMoDdcw692jrLv
```

## 1. Scope

Inspect the actual GameEscrow getter interface vs the live runner's `get_contract_state` call. Separate:

* Question A — did OPEN_PAYMENTS succeed on-chain?
* Question B — can `get_contract_state` read that state?

If A=YES and B=NO, continue the **same** TESTNET session through STAKE. Do not deploy a replacement GameEscrow. Do not modify Page4/Page5/client. Do not re-audit Deposit or GameContractManager.

## 2. Files inspected

| Path | Why |
|------|-----|
| `contracts/game_escrow/GameEscrow.tact` | Authoritative getters and `STATUS_PAYMENTS_OPEN=3` / `STATUS_READY=5` |
| `server/payment/ton/gameContract/GameContractOpcodes.js` | T2.3 names `get_contract_state` / `get_paid_mask` |
| `server/payment/TonGameContractAdapter.js` | `getContractState` → `runGetMethod("get_contract_state")` |
| `server/payment/ton/gameContract/GameContractDeserializer.js` | `decodeContractState` stack layout |
| `server/payment/BlockchainMonitor.js` | Production GameEscrow payment truth is `getPaidMask` / `get_status` |
| `server/tests/testnet/runValueTonSweep.js` | Existing comment: GameEscrow exposes `get_status`, not `get_contract_state` |
| `server/scripts/r770c2_open_payments_and_monitor.mjs` | Existing live `get_status` reader |
| `server/scripts/_r18s15_resume_escrow.mjs` | Live runner that had called the wrong getter |
| `server/gameplay/PaymentSessionManager.js` | `syncFromGameEscrow` requires an in-process session |
| `server/gameplay/GameStartAuthorization.js` | `OPEN_PAGE5` requires `roomManager.getRoom(roomId)` |

## 3. Actual current HEAD

**SOURCE VERIFIED**

```
a7d5fe971cc165a547c5549df77a8990d09c1ba5
a7d5fe9 docs: record R18-S15 commit SHA
```

Branch `main`. Production wiring commit remains `efb394b`.

## 4. Working tree

Dirty with pre-existing untracked reports/probes/sample banners. This continuation changed only untracked live scripts:

* `server/scripts/_r18s15_resume_escrow.mjs` (use `get_status` / `get_paid_mask`)
* `server/scripts/_r18s15_probe_getters.mjs` (read-only)
* `server/scripts/_r18s15_confirm_stakes.mjs` (read-only)

No production source diff.

## 5. Exact `get_contract_state` invocation

**SOURCE VERIFIED** + **REAL TESTNET VERIFIED**

Live runner called `TonGameContractAdapter.getContractState(ESCROW)` which does:

```
_runContractMethod(address, "get_contract_state")
→ TonService.runGetMethod → TonClient.runMethod
```

No arguments. Expected T2.3 stack: status int, optional version, optional paidMask (`decodeContractState`).

Live result:

```
Unable to execute get method. Got exit_code: 11
```

## 6. Exact meaning/cause of exit code 11

**SOURCE VERIFIED** + **ON-CHAIN VERIFIED**

TVM exit 11 on `runGetMethod` here is the method-dictionary miss: the deployed GameEscrow bytecode has **no** `get_contract_state` getter. The same account, same provider, same moment:

| Getter | Result | Evidence class |
|--------|--------|----------------|
| `get_contract_state` | fail, `exit_code: 11` | REAL TESTNET VERIFIED |
| `get_status` | `3` then later `5` | ON-CHAIN VERIFIED |
| `get_paid_mask` | `0` then later `7` | ON-CHAIN VERIFIED |
| `get_required_total` | `3000000000` | ON-CHAIN VERIFIED |
| `get_player_payment(i)` | seat wallets + `requiredStake=1000000000` | ON-CHAIN VERIFIED |

This is **not** evidence that GameEscrow is broken or still uninitialized.

## 7. Actual GameEscrow contract interface

**SOURCE VERIFIED** (`GameEscrow.tact` getters):

```
get_status
get_contract_id_hash
get_snapshot_hash
get_settlement_info
get_paid_mask
get_total_paid
get_required_total
get_player_payment(index)
get_refund_mask
get_refunded_total
get_cancel_status
```

`PAYMENTS_OPEN` is `status == 3`. After all STAKE bits: `status == 5` (`READY`). Authoritative production readers already used in-repo: `get_status` (sweep / r770c2 / BlockchainMonitor settlement) and `getPaidMask` (BlockchainMonitor payment watch).

T2.3 `GAME_CONTRACT_GET_METHODS.CONTRACT_STATE = "get_contract_state"` does not match this Tact contract. Production GCM after OPEN_PAYMENTS does **not** wait on that getter; it uses `openPayments().ok` then `AWAITING_PLAYER_PAYMENTS`. The live runner did wait on it, which is why the previous session stopped.

## 8. Actual OPEN_PAYMENTS on-chain result

### Question A — did OPEN_PAYMENTS execute successfully?

**YES. ON-CHAIN VERIFIED.**

Before STAKE, `get_status=3` (`PAYMENTS_OPEN`). `OpenPayments` in Tact requires `status == DEPLOYED` and oracle sender, then sets `PAYMENTS_OPEN`. Seats decoded from `get_player_payment`:

| Seat | On-chain wallet | requiredStake nano |
|------|-----------------|--------------------|
| 0 | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` | 1000000000 |
| 1 | `EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp` | 1000000000 |
| 2 | `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` | 1000000000 |

`get_required_total=3000000000`. Oracle txs on the escrow (sender `EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ`) remain on-chain. Previous-session sendBoc ids `8OBZzOlv…` / `WEM0RHnN…` are broadcast hashes; TonCenter account txs use different hashes (normal).

### Question B — can `get_contract_state` read it?

**NO. REAL TESTNET VERIFIED.** Still exit 11 after PAYMENTS_OPEN and after READY.

**Conclusion: verification-only. Not a contract-state failure.**

## 9. Whether the problem was verification-only or contract-state failure

**Verification-only.**

A = YES, B = NO. GameEscrow was already `PAYMENTS_OPEN` on the same address. The runner was calling a T2.3 getter name that this contract does not export.

## 10. Code change

**No production source change.**

Live runner `_r18s15_resume_escrow.mjs` was corrected to:

* treat `get_contract_state` exit 11 as non-authoritative;
* read `get_status` / `get_paid_mask` / `get_player_payment` via `TonService.runGetMethod` (same pattern as `r770c2` / `runValueTonSweep`);
* skip re-sending INIT/OPEN when already `PAYMENTS_OPEN`;
* STAKE exact snapshot `requiredGram=1` (1 TON), not Deposit FundSeat 11000000 nano.

`TonGameContractAdapter.getContractState` still calls `get_contract_state`. That leftover was **not** patched in this continuation because production payment authority already uses `getPaidMask` / `get_status`, and GCM does not gate OPEN on `getContractState`. Fixing the adapter is a separate minimal follow-up if `_observeContract` needs that method.

## 11. Focused tests

**NOT VERIFIED / not run for a production diff.** No production file changed, so no adapter/GCM regression suite was re-run. Existing `gameEscrowStake.test.js` already encodes OPEN_PAYMENTS `requiredGram: 1` → `toNano("1")`.

## 12. Existing live contract address

**REAL TESTNET VERIFIED**

```
EQBz6JvvkNk9ct3X6m8C8nKiWdUnm7J2aebMoDdcw692jrLv
contractId=contract_b19bdc62-5c87-4c4a-bb47-86076e99d7f8
roomId=room-l25-1787938991293
gameId=game-l25-1787938991293
```

TESTNET preflight: `TON_NETWORK=testnet`, endpoint `https://testnet.toncenter.com/api/v2/jsonRPC`. Account remained `active`. No MAINNET.

## 13. STAKE transaction #1

**REAL TESTNET VERIFIED** + **ON-CHAIN VERIFIED**

| Field | Value |
|-------|--------|
| seat | 0 |
| player | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` |
| amount | 1000000000 nanoTON (`requiredGram=1`) |
| sendBoc | HTTP 200, bocHash `bac32429d06f49ffde889bc33791c3ca3c3920971c49325f0d5c18917e1ba2a4` |
| on-chain tx | `5o00v17Ggkx5xf4gi7+ugKlqtW09uOxDTFFjzK1G3rY=` |
| in_msg value | 1000000000 |
| wallet seqno | 48 |
| pre-STAKE balance | 19781218374 nano (sufficient) |

## 14. STAKE transaction #2

**REAL TESTNET VERIFIED** + **ON-CHAIN VERIFIED**

| Field | Value |
|-------|--------|
| seat | 1 |
| player | `EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp` |
| amount | 1000000000 nanoTON |
| sendBoc | HTTP 200, bocHash `2b42d12e48c5b45b2f30dd05514230bce2fa6a0f852fc86e2f4b0f6052f1b078` |
| on-chain tx | `iESkMabepB2ukvJ/w0SQfWkeJn1xoWYRuCmrmUCNE7A=` |
| in_msg value | 1000000000 |
| wallet seqno | 47 |
| pre-STAKE balance | 28013947087 nano (sufficient) |

## 15. STAKE transaction #3

**REAL TESTNET VERIFIED** + **ON-CHAIN VERIFIED**

| Field | Value |
|-------|--------|
| seat | 2 |
| player | `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` |
| amount | 1000000000 nanoTON |
| sendBoc | HTTP 200, bocHash `ad83c59714e0e90d34a28863dbc70ffad1549e04e3caa5208ebc5d847ec359ed` |
| on-chain tx | `fnzFHChx8UCqObW7DQMNrpuF+Jit/XkBQ/QP1+m4yXM=` |
| in_msg value | 1000000000 |
| wallet seqno | 37 |
| pre-STAKE balance | 23378916075 nano (sufficient) |

Deposit FundSeat amount was **not** reused.

## 16. On-chain paidMask

**ON-CHAIN VERIFIED** (chain is authoritative; not backend cache)

```
get_paid_mask=7
get_status=5 (READY)
get_total_paid=3000000000
accountBalance=3082021481
accountState=active
```

Re-read after STAKE via `runGetMethod`. Matches Tact: all bits set → `STATUS_READY`.

## 17. Payment completion (`PAYMENT_SESSION_COMPLETED`)

**NOT VERIFIED / BLOCKED**

No in-process `PaymentSession` existed for this room. `PaymentSessionManager.syncFromGameEscrow` fail-closes with `no_active_session` unless a session was created from `GAME_CONTRACT_READY_FOR_PAYMENTS`. The original live GCM process exited during INIT; the resume runner did not include PSM.

## 18. Game-start authorization

**NOT VERIFIED / BLOCKED** — not reached. `GameStartAuthorization` requires `PAYMENT_SESSION_COMPLETED` + `GAME_CONTRACT_PAYMENTS_COMPLETE` and `roomManager.getRoom(roomId)`.

## 19. Bootstrap readiness

**NOT VERIFIED** — `GAME_START_BOOTSTRAP_READY` not emitted.

## 20. Entry payment completion

**NOT VERIFIED** — `ENTRY_PAYMENT_COMPLETED` not emitted.

## 21. OPEN_PAGE5

**NOT VERIFIED / BLOCKED** — `RoomLobbyBridge` is not in this live stack. `OPEN_PAGE5` is a lobby socket event after game-start authorization. This L25 room is not a production lobby room.

## 22. Exact final authoritative server state

On-chain (authoritative for this continuation):

```
GameEscrow READY
paidMask = 7
totalPaid = 3000000000 nanoTON
```

Server process: resume runner exited `STAKES_COMPLETE`, `page5Reached=false`. No production `GameContractManager` / `PaymentSessionManager` / `GameStartAuthorization` / `RoomLobbyBridge` instance was attached to this resume.

## 23. Exact first blocker if Page5 was not reached

```
LAST VERIFIED STATE
    GameEscrow on-chain READY; paidMask=7; 3 × STAKE confirmed
EXACT NEXT EXPECTED STATE
    PAYMENT_SESSION_COMPLETED
EXACT OPERATION THAT FAILED
    No production PaymentSession / lobby was running for room-l25-1787938991293
EXACT ERROR
    Live TESTNET stack used Deposit coordinators + GameContractManager for deploy,
    then a resume runner for STAKE. It never composed PaymentSessionManager,
    GameStartAuthorization, or RoomLobbyBridge.
RELEVANT FILE / FUNCTION
    server/gameplay/PaymentSessionManager.js (session created on GAME_CONTRACT_READY_FOR_PAYMENTS)
    server/gameplay/GameStartAuthorization.js (_checkStartConditions → room_missing without lobby room)
    server/socket/RoomLobbyBridge.js (OPEN_PAGE5)
RUNTIME EVIDENCE
    resume log: page5Reached=false;
    note=PaymentSession/GameStartAuthorization/RoomLobbyBridge not in this live stack
WHETHER THE BLOCKER IS
    environment / process composition
    (not GameEscrow state, not wallet balance, not TESTNET getter, not MAINNET)
```

A synthetic PaymentSession or lobby room was **not** fabricated to emit Page5 events.

## 24. Commit SHA if source changed

**N/A.** Production source unchanged. HEAD `a7d5fe9`. No commit, no push.

## Architecture findings (continuation)

The previous stop at exit 11 mixed two facts. The deployed GameEscrow already implemented `get_status`. The T2.3 adapter method `getContractState` still names a getter that Tact never exported. Existing TESTNET sweep code already documented that mismatch.

## Lifecycle flow reached

```
DEPOSIT_FULL
    ↓
DEPLOY_AUTHORIZATION_VALID
    ↓
_handleDeploymentAuthorizationValid
    ↓
createContractRequest
    ↓
consumeValidForDeploy
    ↓
GameEscrow DEPLOYED
    ↓
INIT_GAME
    ↓
OPEN_PAYMENTS                         [on-chain PAYMENTS_OPEN = 3]
    ↓
3 × GameEscrow STAKE (1 TON each)
    ↓
paidMask = 7
    ↓
get_status = READY (5)
    ↓
PAYMENT_SESSION_COMPLETED             STOP (no PSM in live stack)
```

## Ownership boundaries

Unchanged. GameEscrow remains on-chain payment authority. PaymentSessionManager only synchronizes. Page5 remains lobby-owned. This continuation did not move those boundaries.

## Risks

| Level | Item |
|-------|------|
| Medium | Production `getContractState` still calls a non-existent getter; `_observeContract` will catch/skip GameEscrow status via that path |
| Medium | Live E2E to Page5 needs the production lobby process, not only the Deposit+GCM+STAKE runner |
| Low | Adapter `getPlayerPayment` wallet decode via `Object.toString` can yield `"[object Object]"` on live TupleReader stacks; TupleReader `readAddress` works |

## Recommendations

1. Next task: compose the existing production PaymentSession + GameStartAuthorization + RoomLobbyBridge against this already-READY GameEscrow **or** a new full production-stack room — without fabricating events.
2. Optional later: map `TonGameContractAdapter.getContractState` to `get_status` (+ `get_paid_mask`) with a focused adapter test. Do not change GameEscrow FunC for this.

## Changes made

Untracked live runner/probe scripts only. No production commit.

---

# Historical investigation (earlier S15 session)

The following sections are the original missing-caller investigation. They are **not** the implementation session above. Classification at that time was also `R18_S15_PARTIAL`, with **no production source change**.

R18-S14 already completed a real TESTNET Deposit lifecycle through `DEPOSIT_FULL` and `DeploymentAuthorization VALID`. That investigation did **not** restart the Deposit audit. At that time the production server had a complete GameEscrow deploy/STAKE/start implementation, but **no production caller** after `DEPLOY_AUTHORIZATION_VALID` invoked `GameContractManager.createContractRequest`. That stop was the documented R17.9L.6 / R17.9L.18 boundary, not a failed consume gate and not only an L25 harness stub.

No GameEscrow deployment or STAKE transaction was sent in the investigation session. No production source was changed in that session. Page4 and Page5 were not modified. DepositContract logic and Deposit economic parameters were not changed.

---

## 1. Git baseline

```
HEAD: 9707666 (HEAD -> main, origin/main) R18-S11 recovery: restore Page4 Deposit integration
branch: main
```

R18-S11 recovery commit `9707666` **is present**.

`git status --short` at start of this task showed a dirty working tree of **pre-existing** untracked Cline reports, local probe files, sample banners, logs, and two modified sample JPGs plus one older S3 report. Those files were **not** cleaned, reset, or used as production source. No unexpected `client/src` or `server/` production source diffs were present.

---

## 2. Starting HEAD

```
9707666c112fc54755f9b53ac0a17889bee37cad
9707666 (HEAD -> main, origin/main) R18-S11 recovery: restore Page4 Deposit integration
```

Recent log (`git --no-pager log --oneline --decorate -15`) starts at `9707666` and includes the R18-S11 recovery commit. No new source commit was created for R18-S15.

---

## 3. R18-S14 starting state

Baseline report: `AI_CONTEXT/CLINE_REPORTS/2026-08-28_r18_s14_server_deposit_to_page5_e2e_report.md`  
Classification of that run: **R18_S14_PARTIAL**

Proven on real TESTNET (not restated as a new Deposit investigation):

```text
DepositContract
    ↓
3 player FundSeat payments
    ↓
on-chain FULL / paidMask=7
    ↓
server DEPOSIT_FULL
    ↓
DeploymentAuthorization VALID
    ↓
STOP
```

| Item | Value |
|------|--------|
| depositId | `dep_f61f4bcc-1330-4833-bbe3-45b4b15ed443` |
| DepositContract | `EQAKNgpwhBoHZglNOS9F9hQ9A_PGnWrgBz2Hsg69g0NvTypu` |
| On-chain (S14 and S15 re-read) | `get_status=3` (`FULL`), `get_paid_mask=7` |
| Server | `DEPOSIT_FULL` → `DEPLOY_AUTHORIZATION_VALID` |
| GameEscrow | **not** created (`gameContractDeployCalls=0`) |
| Persistence | L25 **temp dir** (`mkdtempSync`), **not** `server/data/ton-financial` |

FundSeat tx hashes (S14, real TESTNET):

- Deploy (seat 0): `t9nmYb87gxp4NSXfiIhvSxiFSX4md3kYtCgzofeRqbM=`
- Seat 0: `FVa89pEgvWgCoRJTKIgFTnaKtEP5Vvafa1mDTLa01KY=`
- Seat 1: `SmmCYEa4UezL58sncDfLMjz5M1nxiFPSHFhu0oicx5M=`
- Seat 2: `2o3w5OBm704Dx+p3DY2MxBejkZsLsNt4dbqQzGQvT4I=`

This task started exactly there. It did not re-run FundSeat.

---

## 4. TESTNET confirmation

```
TON_NETWORK=testnet
TonCenter JSON-RPC used for read-only getters: https://testnet.toncenter.com/api/v2/jsonRPC
```

Preflight loaded `server/.env` into process env without printing it. `TON_NETWORK` resolved to `testnet`. The script would have exited immediately if the value had been `mainnet`.

**No MAINNET endpoint was selected. No MAINNET transaction was sent. No TESTNET GameEscrow transaction was sent in R18-S15.**

---

## 5. Existing infrastructure used

Preferred existing path; no replacement harness was created.

| Piece | Role in S15 |
|--------|-------------|
| R18-S14 L25 live run | Baseline VALID authorization (temp persistence only) |
| `server/scripts/run-testnet-r179l25.js` / `server/tests/testnet/r179l25/` | Proven Deposit path; **intentionally** stubs `GameContractManager` |
| Production `DepositFullAuthorizationAutomation` | Stops at VALID; does not call GCM |
| Production `GameContractManager` | Existing deploy/STAKE/open-payments path **if** `createContractRequest` is invoked |
| Production `DeploymentAuthorizationCoordinator.consumeValidForDeploy` | Fail-closed single-use consume, used by GCM `_beginDeploy` |
| Production `TonGameContractAdapter` | Oracle/deployer DEPLOY + INIT_GAME + OPEN_PAYMENTS; player STAKE is separate |
| Automated unit/integration tests | Authorization, GCM isolation, game-start, bootstrap, Deposit regression |
| Read-only TESTNET getters | Confirm S14 DepositContract still `FULL` / `paidMask=7` |

Not used as a substitute production path:

- `server/scripts/r770c1_deploy_init_game.mjs` and `server/tests/testnet/runValueTonSweep.js` call `adapter.deployContract` **directly**. That bypasses `DeploymentAuthorization` and would not consume the S14 authorization.
- L25 was **not** re-executed. Re-running it would only repeat Deposit and still throw `L25 STOP BOUNDARY`.

The L25 stop is **not only a harness restriction**. It matches production R17.9L.6 / L.18: VALID authorizations are created, and GameContractManager is **not** invoked from Deposit/payment events.

---

## 6. Existing production GameContract deployment path

Static inspection of current source (not a new mechanism):

```text
createContractRequest(roomId, { gameId })
    → CONTRACT_CREATED / CREATING
    → _scheduleCreated
    → CREATED → AWAITING_PAYMENTS → READY_FOR_BLOCKCHAIN
    → _beginDeploy
    → consumeValidForDeploy({ roomId, gameId, network })
    → CONSUMED (single-use)
    → DEPLOYING
    → TonGameContractAdapter.deploy  (oracle/deployer wallet)
    → INIT_GAME + OPEN_PAYMENTS     (oracle/deployer wallet)
    → AWAITING_PLAYER_PAYMENTS
```

Authoritative modules:

- `server/gameplay/GameContractManager.js` — `createContractRequest`, `_scheduleCreated`, `_beginDeploy`, `_beginDeployAuthorized`, `_consumeDeploymentAuthorizationOrThrow`
- `server/payment/TonGameContractAdapter.js` — `deploy` / `deployContract` / `_sendOracleMessage`
- Domain event on create: `CONTRACT_CREATED` (`EVENT_TYPES.CONTRACT_CREATED`). There is **no** production event named `GAME_CONTRACT_CREATED`. DepositSession has `markGameContractCreated()`, but **no production GameContractManager caller** invokes it (only Deposit session unit tests).

`GameContractManager.initialize()` (R17.9L.18) explicitly does **not** subscribe `PAYMENT_SESSION_UPDATED` / `PAYMENT_REQUESTED` / `PAYMENT_CONNECTION_READY` / `DEPOSIT_FULL` / `DEPLOY_AUTHORIZATION_VALID` as a deploy trigger.

Production `createContractRequest` / `createContract` / `deployContract` callers in `server/` outside GCM itself are **tests and operational scripts**, not `app.js`, `RoomLobbyBridge`, `GameManager`, `PaymentSessionManager`, `GameplayLifecycle`, or `SetupSessionLifecycle`.

`DEPLOY_AUTHORIZATION_VALID` production subscribers that start GCM: **none**. Subscribers found are L25 / L19 harnesses and authorization unit tests.

---

## 7. DeploymentAuthorization consumption path

Exact current functions:

```text
DEPOSIT_FULL
    → DepositFullAuthorizationAutomation._handleDepositFull
    → createFromDepositSession / markValid
    → DEPLOY_AUTHORIZATION_VALID
    → [no production GCM caller]
```

When GCM deploy **is** invoked (tests / explicit `createContractRequest`):

```text
_beginDeployAuthorized
    → _consumeDeploymentAuthorizationOrThrow
    → DeploymentAuthorizationCoordinator.consumeValidForDeploy({ roomId, gameId, network })
    → assertAuthorizationReadyForDeploy
    → consume(authorizationId)
    → DEPLOY_AUTHORIZATION_CONSUMED
    → adapter.deploy  (authorization already CONSUMED before spend)
```

Verified from current source / existing tests (not a new model):

| Rule | Result |
|------|--------|
| Authorization belongs to the Deposit session's `roomId` + `gameId` | `createFromDepositSession` + `getByRoomAndGame` / `_loadExisting` |
| Single-use | `consume()`; duplicate `consumeValidForDeploy` rejected (R17.9L.5B / L.19 tests) |
| Not consumed before actual deploy attempt | Consume is inside `_beginDeployAuthorized` immediately before `DEPLOYING` / adapter spend |
| Invalid/expired rejected | `assertAuthorizationReadyForDeploy` fail-closed |
| Successful consume permits exactly that GameEscrow deploy | GCM then calls `TonGameContractAdapter.deploy` for that contract |

The S14 VALID authorization **cannot be reused**:

- L25 persistence was a temp directory.
- Grep of `server/data/ton-financial` found **no** `dep_f61f4bcc` and **no** DepositContract `EQAKNgp…`.
- Reusing it would require faking VALID or re-running Deposit. Both were forbidden as substitutes for the production consume path.

Authorization model was **not** modified.

---

## 8. Creator rule

Current production source (unchanged):

1. `RoomLobbyBridge._handleCreateRoom` records the room creator as the player who created the room: `_roomCreators.set(room.roomId, playerId)`.
2. `projectDepositForPlayer.js` sets `isCreator` from that id (`creatorId === playerId`).
3. Creator must occupy seat 0 (first admitted binding). A contradiction (`isCreator === true && seatIndex !== 0` or `isCreator === false && seatIndex === 0`) **fail-closes** the projection (`mySeatIndex=null`, `isCreator=null`).

Creator is **not** inferred merely because a wallet is seat 0. Seat 0 and creator are derived independently and must agree.

R18-S14 L25 fixture had no live `RoomLobbyBridge`; seat 0 / player0 performed Deposit deploy, matching the production Creator ≡ seat 0 rule.

Creator assignment was **not** changed.

---

## 9. Three player identities (public identifiers only)

Same L25 TESTNET W5R1 wallets as R18-S14:

| Seat | Label | Public wallet |
|------|-------|----------------|
| 0 | player0 (creator-role in S14 fixture) | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` |
| 1 | player1 | `EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp` |
| 2 | player2 | `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` |

No mnemonics, seeds, or private keys were printed or committed.

These wallets were **not** used to send GameEscrow STAKE in R18-S15.

---

## 10. GameEscrow deployment result

**Not executed.**

Stopping layer: **2 — GameEscrow deployment request**.

Reason: production has no caller of `createContractRequest` after `DEPLOY_AUTHORIZATION_VALID`. The L25 harness throws `L25 STOP BOUNDARY — GameContract create/deploy forbidden` if that call is attempted. Inventing a new caller, bypassing authorization, or driving `TonGameContractAdapter.deployContract` from an ops script would violate the task constraints.

GameEscrow / game contract address: **none for this session**.

---

## 11. GameEscrow deployment transaction hash

**None.** No GameEscrow deploy BOC was broadcast on TESTNET or MAINNET during R18-S15.

---

## 12. GameEscrow activation result

**Not reached.**

Static path after a successful adapter deploy (not executed here):

- `applyDeploymentSuccess` stores `contractAddress` / `deploymentTxId`
- If `gameEscrowMode === "game"`: oracle `INIT_GAME` then `OPEN_PAYMENTS`
- Then `AWAITING_PLAYER_PAYMENTS`

Payer for DEPLOY / INIT_GAME / OPEN_PAYMENTS: WheelWin deployer/oracle (`TonGameContractAdapter._sendOracleMessage`, mnemonic-backed deployer). **Not** player wallets.

---

## 13. GameEscrow seat assignments

**Not created for this session.**

Authoritative mapping when GCM create **does** run (`buildGameContractSnapshot`):

- Seat order = room admission `playerIds`
- Wallet = `sessionWalletStore.getWallet(roomId, playerId)`
- `requiredGram = calculateRequiredGram(baseStake, sectorCount)`
- Snapshot frozen at `createContractRequest`

There is no GameEscrow seat table to report for R18-S15 because no contract was created.

---

## 14. GameEscrow payment amounts and authoritative source

Static production source (not assumed; not executed):

| Item | Source |
|------|--------|
| Amount | `calculateRequiredGram(baseStake, sectorCount)` in `server/payment/calculateRequiredGram.js` — first sector = `baseStake`; two sectors = `baseStake + 1.5 * baseStake` |
| Snapshot field | `buildGameContractSnapshot` → `player.requiredGram` |
| PaymentSession | participant `requiredGram` / `requiredAmount` |
| On-chain STAKE value | `toNano(String(requiredGram))` (1 Gram catalog unit → 1 TON) |
| Opcode | `GAME_CONTRACT_OPCODES.STAKE = 0x5354414B` |
| Body | `serializeGameEscrowStakeBody({ playerIndex })` — `op:uint32` + `playerIndex:uint8` |
| Who pays STAKE | **Player wallet bound to that seat**, not the server/deployer wallet |
| Who pays deploy | Deployer/oracle wallet |

For the S14 fixture (`baseStake=1`, `sectorCount=1`) the GameEscrow STAKE amount would be **1 TON per seat** (`requiredGram=1`). That is a **different** financial phase from Deposit FundSeat **11000000 nanoTON**. Deposit amounts were not reused as GameEscrow STAKE amounts.

---

## 15. Player STAKE #1 evidence

**Not executed.** No seat-0 GameEscrow STAKE transaction.

---

## 16. Player STAKE #2 evidence

**Not executed.** No seat-1 GameEscrow STAKE transaction.

---

## 17. Player STAKE #3 evidence

**Not executed.** No seat-2 GameEscrow STAKE transaction.

---

## 18. On-chain verification results

### DepositContract (R18-S14, read-only re-check in S15)

Endpoint: `https://testnet.toncenter.com/api/v2/jsonRPC`  
Address: `EQAKNgpwhBoHZglNOS9F9hQ9A_PGnWrgBz2Hsg69g0NvTypu`

| Getter | exit_code | value |
|--------|-----------|--------|
| `get_status` | 0 | `3` (`FULL`) |
| `get_paid_mask` | 0 | `7` |

This confirms the S14 Deposit remains FULL on TESTNET. It does **not** create a GameEscrow or consume a durable VALID authorization in production persistence.

### GameEscrow

**No GameEscrow address, no STAKE observations, no paidMask from GameEscrow.**

Production STAKE verification (static, not run):

```text
BlockchainMonitor GAME_ESCROW_STAKE_CONFIRMED
    → PaymentSessionManager.syncFromGameEscrow
    → GameEscrow paidMask is authoritative; backend cache never overrides chain
```

---

## 19. Payment session completion result

**Not reached.**

Expected production names after all GameEscrow seats are confirmed:

```text
PaymentSession FULLY_PAID / complete
    → EVENT_TYPES.PAYMENT_SESSION_COMPLETED
    → GameContractManager._handlePaymentSessionCompleted
    → markPaymentsComplete
    → GAME_CONTRACT_PAYMENTS_COMPLETE (contract status PAYMENTS_COMPLETE)
```

No PaymentSession was created for the S14 Deposit session in production persistence.

---

## 20. GameStartAuthorization result

**Not reached.**

Production coordinator: `server/gameplay/GameStartAuthorization.js`.

It subscribes to `PAYMENT_SESSION_COMPLETED` and `GAME_CONTRACT_PAYMENTS_COMPLETE`, then `_evaluate` → `_authorizeAndBootstrap` → emit `GAME_START_AUTHORIZED`.

No `GAME_START_AUTHORIZED` event exists for this session.

---

## 21. GAME_START_BOOTSTRAP_READY result

**Not reached.**

After authorization, `GameStartAuthorization` validates bootstrap (`_validateBootstrap`) and emits `GAME_START_BOOTSTRAP_READY`.

`RoomLobbyBridge` subscribes to that event and calls `_handleGameStartBootstrapReady` → `_completeEntryPayment`.

---

## 22. ENTRY_PAYMENT_COMPLETED result

**Not reached.**

Production: `RoomLobbyBridge._completeEntryPayment` delivers `LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_COMPLETED` to the room and emits domain `EVENT_TYPES.ENTRY_PAYMENT_COMPLETED`. Idempotent via `_entryPaymentCompletedByRoom`.

`GameManager` activates gameplay from `ENTRY_PAYMENT_COMPLETED` (`_activateGameplaySession`).

---

## 23. OPEN_PAGE5 result

**Not reached.**

Production: `_completeEntryPayment` then `_deliverOpenPage5`. `GameStartAuthorization` phase `OPENED` is `"OPEN_PAGE5"`. Clients enter Page5 from that server signal. This task did not modify the client.

---

## 24. Final authoritative Page5-ready state

**Not reached.**

Last authoritative state that actually exists for this financial session:

```text
On-chain DepositContract FULL / paidMask=7
Server (S14 L25 temp stack only): DEPOSIT_FULL + DeploymentAuthorization VALID
Production durable persistence: no dep_f61f4bcc session, no VALID auth, no GameEscrow
```

Page5-ready would require `ENTRY_PAYMENT_COMPLETED` + `OPEN_PAGE5` from the live RoomLobbyBridge path above.

---

## 25. Reconnect / idempotency result

**Not applicable** to GameEscrow/Page5 (those states were never entered).

Relevant existing rules, inspected only:

- Duplicate `consumeValidForDeploy` is rejected (single-use).
- Duplicate `_completeEntryPayment` is a no-op (`_entryPaymentCompletedByRoom`).
- `syncFromGameEscrow` treats chain `paidMask` as authoritative and is designed to be idempotent on duplicate STAKE observations.
- After `ENTRY_PAYMENT_COMPLETED`, reconnect restores `ENTRY_PAYMENT_COMPLETED` + `OPEN_PAGE5`.

---

## 26. Log / debug evidence

### Local / on-chain

- S14 L25 live log established VALID + `gameContractDeployCalls=0`.
- S15 read-only TonCenter getters: DepositContract still `FULL` / `paidMask=7`.
- `server/data/ton-financial` has **no** S14 `depositId` / DepositContract records (L25 used temp persistence).

### https://wheelwin-nine.vercel.app/debug

Not used as proof of this session. The S14 run was an L25 local stack with temp persistence, not the production Railway/Vercel process. Correlating that debug console to `dep_f61f4bcc` would mix unrelated live rooms with a disposable harness session.

No extra production logging was added.

---

## 27. Automated test results

All of the following were run from `G:\WheelWin\server` with `node --test`. **All passed (fail 0).**

| File | Result |
|------|--------|
| `tests/gameContract.deploymentAuthorizationGate.r179l5b.test.js` | 6 pass |
| `tests/gameContract.legacyDeployTriggerIsolation.r179l18.test.js` | 7 pass |
| `tests/gameStartAuthorization.test.js` | 1 pass |
| `tests/gameplayBootstrap.integration.test.js` | 1 pass |
| `tests/depositFull.deploymentAuthorizationAutomation.r179l6.test.js` | 6 pass |
| `tests/gameEscrowStake.test.js` | 1 pass |
| `tests/deploymentAuthorization.r179l5a.test.js` | 10 pass |
| `tests/depositOnChainVerification.r179l8.test.js` | 18 pass |
| `tests/r18DepositProjection.test.js` | 1 pass |
| `tests/depositBackendE2E.r179l19.test.js` | 24 pass |
| `tests/gameContract.manager.test.js` | 1 pass |
| `tests/paymentSession.manager.test.js` | 1 pass |

These tests prove the **existing** consume gate, L.18 isolation (payment events must not call `_beginDeploy`), L.6 VALID automation, GameEscrow STAKE body, game-start/bootstrap, and Deposit regression. They are **not** a real TESTNET GameEscrow→Page5 run.

L.19 / L.5B tests that call `createContractRequest` after VALID do so **inside the test harness**, which is the documented remaining entry. Production `app.js` still does not make that call.

---

## 28. Any production code changes

**None.**

No defect-fix patch was applied. Wiring `DEPLOY_AUTHORIZATION_VALID` → `createContractRequest` would be a new production integration (historical GAP-B), not a one-line repair of a broken function. The task forbade inventing a new deployment mechanism and forbade removing the L.6/L.25 stop blindly.

---

## 29. Exact changed files

Production / client source: **none**.

Added by this task:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-28_r18_s15_server_gameescrow_to_page5_e2e_report.md` (this report)

---

## 30. Final Git status

After this report (source tree otherwise unchanged from the S15 start snapshot):

```
HEAD: 9707666 (main, origin/main)
```

Working tree remains dirty with the same pre-existing untracked/modified user files, plus this new untracked report. No `client/src` or `server/` production files were modified.

A source commit was **not** created (no source changes).

---

## 31. Commit SHA if source code changed

**N/A.** No source commit. HEAD remains `9707666`.

---

## 32. Exact stopping point (PARTIAL)

```text
DEPLOY_AUTHORIZATION_VALID
        ↓
[explicit production boundary]
R17.9L.6 DepositFullAuthorizationAutomation:
  "No TON and no GameContractManager calls; only ensures VALID authorizations exist."
R17.9L.18 GameContractManager.initialize:
  does not subscribe Deposit/payment events as createContractRequest / _beginDeploy
L25 harness (if reused): throws L25 STOP BOUNDARY
S14 VALID auth: not in durable production persistence
        ↓
STOP — layer 2: GameEscrow deployment request
```

Downstream states **not** reached: GameEscrow deployed, activation, STAKE 1/2/3, payment verification, `PAYMENT_SESSION_COMPLETED`, `GAME_START_AUTHORIZED`, `GAME_START_BOOTSTRAP_READY`, `ENTRY_PAYMENT_COMPLETED`, `OPEN_PAGE5`.

This is classified **PARTIAL**, not **BLOCKED**: `consumeValidForDeploy` and `GameContractManager` are implemented and covered by tests; the server stops at an **explicit existing boundary** outside this task. It is not **VERIFIED** because no real TESTNET GameEscrow→Page5 run occurred.

---

## 33. Page4 was NOT modified

Confirmed. `client/src/pages/Page4Payment.jsx` was not edited. Client socket transport, navigation, and payment builders were not edited.

---

## 34. DepositContract logic was NOT redesigned

Confirmed. No Deposit orchestrator, monitor, FundSeat encoding, or Deposit contract artifact was changed.

---

## 35. No Deposit economic parameters were changed

Confirmed. FundSeat expected amounts remain as proven in S14 (`11000000` nanoTON per seat for the `1:1` profile). No env financial knobs were rewritten by this task.

---

## 36. No MAINNET transaction was sent

Confirmed. Preflight required `TON_NETWORK=testnet`. The only chain I/O in S15 was **read-only** `runGetMethod` against `https://testnet.toncenter.com/api/v2/jsonRPC`. No `sendBoc` / deploy / STAKE broadcast was performed.

---

## 37. No secrets were exposed or committed

Confirmed. This report contains only public wallet addresses, contract addresses, TESTNET transaction hashes from S14, and getter results. It does not contain mnemonics, seed phrases, private keys, passwords, API tokens, or a complete `.env`.

---

## Evidence classes (do not conflate)

| Class | What it shows |
|--------|----------------|
| Static code inspection | Production path after VALID; L.6/L.18 stop; consume-before-deploy; STAKE opcode/amounts; Creator ≡ seat 0; Page5 signal chain |
| Automated tests | Authorization consume, GCM isolation, L.6 VALID automation, STAKE body, game-start/bootstrap, Deposit regression — **all pass** |
| Real TESTNET transactions | **S14 Deposit only** (FundSeat hashes above). **S15: none** |
| Server authoritative state | S14 L25 temp stack reached VALID. Production durable store has no that session |
| Page5-ready state | **Not reached** |

---

## Failure taxonomy (S15)

Stopped at **layer 2 — GameEscrow deployment request**.

Layers 3–16 were not attempted because layer 2 has no production entry that this task was allowed to add.

**Historical only.** The LIVE TESTNET continuation later deployed GameEscrow, opened payments, and completed 3× STAKE (`paidMask=7`). Page5 remains blocked on lobby composition, not on that missing caller.

---

# LIVE TESTNET — PRODUCTION LOBBY / PAYMENT SESSION / PAGE5 CONTINUATION

Date: 2026-08-28  
Classification: **R18_S15_PARTIAL** — production lobby reached on-chain Deposit FULL; Page5 was not reached.

L25 room `room-l25-1787938991293` / GameEscrow `EQBz6JvvkNk9ct3X6m8C8nKiWdUnm7J2aebMoDdcw692jrLv` was **not reused**. No additional STAKE was sent to that contract. Page4 and Page5 were not modified. `get_contract_state` was not added to GameEscrow. Lifecycle events were not emitted by the driver.

## 1. Actual starting HEAD

```
a7d5fe971cc165a547c5549df77a8990d09c1ba5
a7d5fe9 docs: record R18-S15 commit SHA
```

Branch: `main`.

## 2. Working tree

Dirty with the same pre-existing untracked reports, probes, sample banners, and operational scripts as prior S15 sessions. Production source at start of this continuation had **no uncommitted Deposit/GCM/lobby diffs**. This continuation later committed `DepositOrchestrator` only (see §27).

## 3. TESTNET preflight

**SOURCE VERIFIED + SERVER RUNTIME VERIFIED**

```
TON_NETWORK=testnet
endpoint=https://testnet.toncenter.com/api/v2/jsonRPC
TON_DEPLOY_MODE=live
```

Fail-closed if MAINNET. `TonService` logged `network=testnet`. Wallet-readiness `status=READY`. MAINNET readiness check ran as a non-active inventory (`activeNetwork=testnet`) and was **FAIL** (unconfigured MAINNET oracle) — no MAINNET broadcast.

No mnemonics, bot token, or `.env` contents are recorded here.

## 4. Production application composition used

**SOURCE VERIFIED + SERVER RUNTIME VERIFIED**

Same process: `node app.js` (`WheelWinApplication`). One EventBus owned:

- `RoomManager` / `RoomLobbyBridge` (Telegram HMAC `CREATE_ROOM`)
- `PaymentSessionManager` (created on `PAYMENT_CONNECTION_READY`)
- `GameStartAuthorization`
- `GameContractManager` (`TON_DEPLOY_MODE=live`)
- `DepositOrchestrator` / `DepositActivationVerificationCoordinator` / `DepositMonitor` / `DeploymentAuthorizationCoordinator`

Driver: untracked `server/scripts/_r18s15_production_page5.mjs`. It drives three `socket.io-client` seats through the existing lobby protocol, then signs player Deposit deploy / FundSeat / later STAKE. It does **not** emit `PAYMENT_SESSION_COMPLETED`, `GAME_START_AUTHORIZED`, or `OPEN_PAGE5`.

`PaymentSession` is **not** created from `GAME_CONTRACT_READY_FOR_PAYMENTS`. Production creates it from `PAYMENT_CONNECTION_READY` (wallet barrier). `GAME_CONTRACT_READY_FOR_PAYMENTS` only issues deployed payment requests. **SOURCE VERIFIED.**

## 5–8. Fresh room, game, players, seats

Authoritative production room (not L25):

| Field | Value | Evidence |
|--------|--------|----------|
| roomId | `JorV` | SERVER RUNTIME VERIFIED |
| gameId | `game_6b438c5c-09fc-438e-a37b-8b8cea8b908e` | SERVER RUNTIME VERIFIED |
| Creator / seat 0 | `player_69f566b9-0458-41d2-9696-b5946d776a8c` | SERVER RUNTIME VERIFIED |
| seat 1 | `player_ddae5df2-df13-4a0b-8ac0-e3c223334002` | SERVER RUNTIME VERIFIED |
| seat 2 | `player_319c05f9-8476-4fa1-b966-88fc6fa4710c` | SERVER RUNTIME VERIFIED |
| seat 0 wallet | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` | public |
| seat 1 wallet | `EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp` | public |
| seat 2 wallet | `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` | public |

Profiles used existing allowed `baseStake: 1`. Deposit expected amount per seat: `11000000` nanoTON.

Abandoned first attempt (driver mapping bug, do not treat as Page5 proof): lobby room `Smsp`, `game_bd31a83e-7f3d-4119-ad72-8cfb93138900`, deposit `EQBTbeU6RTV5Ll-FfjpC_lGp0KY45Y8VIH-eavWMjddyDOiy` became ACTIVE on-chain; `waitUntilActive` compared TonCenter `"active"` to mapped `"ACTIVE"` and timed out. No FundSeat on that session.

## 9. DepositContract result

**REAL TESTNET VERIFIED + ON-CHAIN VERIFIED + SERVER RUNTIME VERIFIED**

JorV:

```
depositId=dep_ab08faa5-7497-4168-a90f-8d62159f41ab
depositAddress=EQC87Mgi9Zpd3EgIdPFpw9YYrrvBh3fse_hEdj8p7pQJ_neE
depositDeployTx=ulntOR/ZcZBEsHQna8xYdK9TKySglvJCuv3X2+3MWKM=
depositDeploySender=EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le
accountState=active
balance=78907705 nanoTON
```

`DEPOSIT_PACKAGE_PUBLISHED` from production `DepositOrchestrator`. Player-signed deploy used the existing L25 helper with production `RealTonDepositBlockchainSource.getContractState` (mapped `ACTIVE`).

`DEPOSIT_ACTIVATION_WAITING` then `DEPOSIT_ACTIVATION_VERIFIED` on the live `app.js` EventBus (`Subscribers: 1` for WAITING after the orchestrator wiring). **SERVER RUNTIME VERIFIED.**

Three FundSeat broadcasts (TESTNET `sendBoc` HTTP 200, 11_000_000 nanoTON each):

```
seat0 bocHash=ec4ce0244c92f81a846c3e570c2dac537ee981016b3c52511e0e5f86600a34c5
seat1 bocHash=cb0c307cf9d1de63e4c2975caabc5100f675469d27162b3f20ed9e917449b213
seat2 bocHash=e89002d7292880b179d2a4d64c70d265d9f5423034e2cff0ab3073cf03f7704e
```

On-chain after FundSeat:

```
get_paid_mask = 0x7 (7)
get_credited_amount0 = 0xa7d8c0 (11000000)
```

`get_status` RPC timed out on a later read; `paidMask=7` plus credited seat 0 is sufficient to treat funding as complete. **ON-CHAIN VERIFIED.** Production `DepositSession` remained `AWAITING_FUNDS` in the lobby log. **NOT VERIFIED as DEPOSIT_FULL in server domain state.**

## 10. DeploymentAuthorization result

**NOT VERIFIED / BLOCKED**

No `DEPLOY_AUTHORIZATION_VALID` in the JorV production log. `DepositOnChainVerificationCoordinator` never received `DEPOSIT_FULL_ONCHAIN`.

## 11–18. GameEscrow deploy, INIT_GAME, OPEN_PAYMENTS, STAKE, paidMask, status

**NOT VERIFIED / BLOCKED**

No GameEscrow address, no deploy transaction, no INIT_GAME, no OPEN_PAYMENTS, no STAKE on this production room. Do not confuse with the earlier L25 READY escrow.

## 19. Production PaymentSession creation

**SERVER RUNTIME VERIFIED**

```
PAYMENT_CONNECTION_READY
PAYMENT_SESSION_CREATED
paymentSessionId=pay_ab075751-1ab9-4aa1-be11-645b815cd521
roomId=JorV
gameId=game_6b438c5c-09fc-438e-a37b-8b8cea8b908e
```

Created by existing `PaymentSessionManager` from the production wallet-barrier event. Not fabricated.

## 20. PAYMENT_SESSION_COMPLETED

**NOT VERIFIED / BLOCKED** — GameEscrow payments never opened.

## 21. GAME_START_AUTHORIZED

**NOT VERIFIED / BLOCKED**

## 22. GAME_START_BOOTSTRAP_READY

**NOT VERIFIED / BLOCKED**

## 23. ENTRY_PAYMENT_COMPLETED

**NOT VERIFIED / BLOCKED**

Entry payment is the post-bootstrap lobby stage, not Deposit FundSeat and not GameEscrow STAKE.

## 24. OPEN_PAGE5

**NOT VERIFIED / BLOCKED**

`RoomLobbyBridge` did not emit `OPEN_PAGE5`. Page5 is not reached.

## 25. Exact final authoritative server state

```
roomId=JorV (production RoomManager / RoomLobbyBridge)
gameId=game_6b438c5c-09fc-438e-a37b-8b8cea8b908e
PaymentSession=pay_ab075751-1ab9-4aa1-be11-645b815cd521 (created, not completed)
depositId=dep_ab08faa5-7497-4168-a90f-8d62159f41ab
depositAddress=EQC87Mgi9Zpd3EgIdPFpw9YYrrvBh3fse_hEdj8p7pQJ_neE
activation=DEPOSIT_ACTIVATION_VERIFIED
DepositSession phase at package time=AWAITING_FUNDS
on-chain Deposit paidMask=7
GAME_CONTRACT_DEPLOYED=absent
OPEN_PAGE5=absent
```

## 26. Exact first blocker (Page5 not reached)

After the activation-retry wiring, the live production stack stopped here:

```
player FundSeat × 3
        ↓
on-chain Deposit paidMask=7
        ↓
DepositMonitor.startWatching (after DEPOSIT_ACTIVATION_VERIFIED)
        ↓
DepositMonitor.poll() is only invoked from BlockchainMonitor._pollGlobal
        ↓
BlockchainMonitor.start() is never called by WheelWinApplication
        ↓
monitor _state remains STOPPED
        ↓
_ensureGlobalPoll() no-ops unless RUNNING
        ↓
DEPOSIT_FULL_ONCHAIN never emitted
        ↓
no domain DEPOSIT_FULL
        ↓
no DEPLOY_AUTHORIZATION_VALID
        ↓
no GameEscrow
        ↓
STOP — GAME_CONTRACT_DEPLOYED
```

**SOURCE VERIFIED.** `app.js` calls `_blockchainMonitor.initialize()` only. There is **no** `blockchainMonitor.start()` anywhere under `server/`. L25 harness polls `depositMonitor.poll()` itself. Production does not.

This is the next smallest existing-architecture connection. It was **not** implemented in this continuation (stop at this blocker).

Earlier in the same continuation, a *previous* missing connection was fixed and retested:

```
DEPOSIT_ACTIVATION_WAITING
        ↓
0 subscribers (before fix)
        ↓
DepositOrchestrator now retries existing verifyActivation while the live room exists
```

JorV proved that retry: `DEPOSIT_ACTIVATION_WAITING` had `Subscribers: 1`, then `DEPOSIT_ACTIVATION_VERIFIED` after player deploy.

## 27. Production source changes

`server/deposit/DepositOrchestrator.js`:

- subscribe to existing `DEPOSIT_ACTIVATION_WAITING`;
- retry existing `verifyActivation` until VERIFIED / terminal / timeout;
- skip retries when `RoomManager` no longer has the room (do not poll recovered dead sessions).

Does **not** call `startWatching` / `authorizeVerifiedWatch` directly. Does **not** emit Page5 events. Does **not** change Deposit economics or GameEscrow FunC.

## 28. Focused tests

```
node --test tests/depositOrchestrator.r179l23.test.js
```

**16 pass, 0 fail.** Includes new test `R18-S15: DEPOSIT_ACTIVATION_WAITING retries existing verifyActivation`. Prior TestI still asserts no watch on first UNINIT verification.

**AUTOMATED TEST VERIFIED.**

## 29. Commit SHA

```
895d126 R18-S15 retry Deposit activation after DEPOSIT_ACTIVATION_WAITING
7c30278 R18-S15 skip Deposit activation retries when the live room is gone
```

`895d126` and `7c30278` are on `origin/main`.

## 30. Final Git state

```
HEAD 7c302780a9a85858f2d2e36e3bac3b14d39869f5
origin/main 7c30278
```

Working tree still has unrelated untracked reports/probes and the untracked production Page5 driver. This report file is updated. No secrets committed.

---

## Evidence classes (this continuation)

| Item | Class |
|------|--------|
| Production lobby CREATE_ROOM / JOIN / PaymentSession | SERVER RUNTIME VERIFIED |
| Deposit deploy + 3× FundSeat | REAL TESTNET VERIFIED |
| Deposit `paidMask=7` | ON-CHAIN VERIFIED |
| `DEPOSIT_ACTIVATION_VERIFIED` | SERVER RUNTIME VERIFIED |
| `BlockchainMonitor.start` missing | SOURCE VERIFIED |
| GameEscrow / STAKE / Page5 on this room | NOT VERIFIED / BLOCKED |
| `OPEN_PAGE5` from `RoomLobbyBridge` | NOT VERIFIED |

Page5 is **not** reached. Next development task: start the existing `BlockchainMonitor` (or otherwise invoke existing `DepositMonitor.poll`) in the production composition so `DEPOSIT_FULL_ONCHAIN` can fire for a live room that is already funded on-chain. Do not reuse L25. Do not fabricate `OPEN_PAGE5`.

---

# LIVE TESTNET — FULL PRODUCTION STACK TO PAGE5

Date: 2026-08-28  
Classification: **R18_S15_PARTIAL**

This run used the real `WheelWinApplication` (`node app.js`) after wiring `BlockchainMonitor.start()`. L25 room `room-l25-1787938991293` and GameEscrow `EQBz6JvvkNk9ct3X6m8C8nKiWdUnm7J2aebMoDdcw692jrLv` were **not reused**. Page4/Page5 were not modified. Lifecycle events were not fabricated.

## 1. Starting HEAD

```
7c302780a9a85858f2d2e36e3bac3b14d39869f5
7c30278 R18-S15 skip Deposit activation retries when the live room is gone
```

## 2. Working tree

Dirty with the same pre-existing untracked reports, probes, and the untracked driver `server/scripts/_r18s15_production_page5.mjs`. Production source at start of this run had no extra uncommitted app/monitor diffs.

## 3. Production composition used

**SOURCE VERIFIED + SERVER RUNTIME VERIFIED**

One process: `WheelWinApplication` (`app.js`), `TON_NETWORK=testnet`, endpoint `https://testnet.toncenter.com/api/v2/jsonRPC`, `TON_DEPLOY_MODE=live`.

Startup log: `BlockchainMonitor started OK` at `2026-08-28T19:46:36.790Z`.

## 4. Shared event bus / state

**SOURCE VERIFIED**

Single `EventBus`. `RoomManager`, `RoomLobbyBridge`, `PaymentSessionManager`, `GameStartAuthorization`, `GameManager`, `GameContractManager`, deposit coordinators, and `BlockchainMonitor` are constructed in `app.js` and share that bus. `setDepositMonitor` then `await this._blockchainMonitor.start()` so `_pollGlobal` can call `DepositMonitor.poll()`.

`PaymentSession` is still created from `PAYMENT_CONNECTION_READY`, not from `GAME_CONTRACT_READY_FOR_PAYMENTS`.

## 5–7. Fresh production room / game / seats

| Field | Value | Class |
|--------|--------|--------|
| roomId | `wMCC` | SERVER RUNTIME VERIFIED |
| gameId | `game_aaba45fc-81b9-4973-b858-d797e259964a` | SERVER RUNTIME VERIFIED |
| Creator / seat 0 | `player_5db0511e-868a-4a3d-868c-f07ba31378cf` | SERVER RUNTIME VERIFIED |
| seat 1 | `player_5a0e29ea-e08a-48e4-9a40-f88670336fe8` | SERVER RUNTIME VERIFIED |
| seat 2 | `player_22490f75-103e-4d56-b934-081cf6be2e6e` | SERVER RUNTIME VERIFIED |
| seat 0 wallet | `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` | public |
| seat 1 wallet | `EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp` | public |
| seat 2 wallet | `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` | public |

## 8. DepositContract lifecycle

**REAL TESTNET VERIFIED (deploy + FundSeat broadcast). SERVER domain FULL: NOT VERIFIED / BLOCKED.**

```
depositId=dep_cacfeb7b-3c2a-4684-a986-6c8568637c65
depositAddress=EQB7Uxq9_UNof0s-TQ8uiof9GQa2n6a7SKmQVB0Ax_XrGZt9
depositDeployTx=Z/vFflihhjtsxeoeGWxqeMddyYV09PIf4Ua0oITT6zU=
```

FundSeat `sendBoc` (11_000_000 nanoTON each):

```
seat0 bocHash=f50841a13a5d139a44bde016bcb9853dbda03c49a64f3efcd66514711e3f5107
seat1 bocHash=019f5139c25cfdace6da1f6051af7a257fd90818c9c6298a1def7706d96c5ee4
seat2 bocHash=c85a649fcf09befc4ffa510fa81a628d6de9f2701be8151513962f2f4f1251a1
```

Live-session `DEPOSIT_ACTIVATION_VERIFIED` for `dep_cacfeb7b-...` did **not** appear. Activation retries logged `Request failed with status code 429`. `DEPOSIT_FULL_ONCHAIN` did not appear. On-chain `paidMask` for this address was **not** re-queried in this run (RPC 429). **ON-CHAIN VERIFIED: NOT VERIFIED.**

## 9. DeploymentAuthorization lifecycle

**NOT VERIFIED / BLOCKED** — no `DEPLOY_AUTHORIZATION_VALID`.

## 10–17. GameEscrow deploy, INIT_GAME, OPEN_PAYMENTS, STAKE, paidMask, READY

**NOT VERIFIED / BLOCKED**

No GameEscrow address. Do not treat the earlier L25 READY escrow as this run.

## 18. GAME_CONTRACT_READY_FOR_PAYMENTS

**NOT VERIFIED / BLOCKED**

## 19. PaymentSession creation

**SERVER RUNTIME VERIFIED**

```
PAYMENT_CONNECTION_READY
PAYMENT_SESSION_CREATED
paymentSessionId=pay_2d70c04b-20d2-4924-964e-4ac6dba5506d
roomId=wMCC
gameId=game_aaba45fc-81b9-4973-b858-d797e259964a
```

Created by production `PaymentSessionManager` from the wallet barrier. Not fabricated. No GameEscrow contract was associated because deploy never ran.

## 20–25. PAYMENT_SESSION_COMPLETED through OPEN_PAGE5

**NOT VERIFIED / BLOCKED**

`RoomLobbyBridge` did not emit `OPEN_PAGE5`.

## 26. Exact final authoritative server state

```
roomId=wMCC
gameId=game_aaba45fc-81b9-4973-b858-d797e259964a
PaymentSession=pay_2d70c04b-20d2-4924-964e-4ac6dba5506d (created, not completed)
depositId=dep_cacfeb7b-3c2a-4684-a986-6c8568637c65
depositAddress=EQB7Uxq9_UNof0s-TQ8uiof9GQa2n6a7SKmQVB0Ax_XrGZt9
BlockchainMonitor=STARTED
live DEPOSIT_ACTIVATION_VERIFIED=absent
DEPOSIT_FULL_ONCHAIN=absent
GAME_CONTRACT_DEPLOYED=absent
OPEN_PAGE5=absent
```

## 27. Exact first blocker

```
LAST VERIFIED STATE
    Production lobby wMCC; PaymentSession created; Deposit deploy + 3× FundSeat broadcast;
    BlockchainMonitor.start() running

EXPECTED NEXT STATE
    DEPOSIT_ACTIVATION_VERIFIED for dep_cacfeb7b-... then DEPOSIT_FULL_ONCHAIN then GAME_CONTRACT_DEPLOYED

EXACT OPERATION
    DepositActivationVerificationCoordinator.verifyActivation (3s retry)
    DepositMonitor.poll via BlockchainMonitor._pollGlobal (2s)

EXACT ERROR
    TonCenter HTTP 429
    DepositOrchestrator activation retry failed | depositId=dep_cacfeb7b-... | error=Request failed with status code 429
    Deposit TON poll failed | depositId=dep_73d80824-279b-4fef-88da-178fbf1a6886 | 429

RELEVANT FILE/FUNCTION
    server/app.js — await this._blockchainMonitor.start()  [this run: present]
    server/payment/BlockchainMonitor.js — _pollGlobal → depositMonitor.poll()
    TonFinancialRecovery recovery watches stale deposit dep_73d80824-...
    server/deposit/DepositOrchestrator.js — _retryActivation every 3s on the live room

RUNTIME EVIDENCE
    No DEPOSIT_FULL, DEPLOY_AUTHORIZATION_VALID, or GAME_CONTRACT_DEPLOYED in the wMCC log.
    Poll target observed in-process is the recovered session dep_73d80824, not the live wMCC deposit.
    Live deposit never reached DEPOSIT_ACTIVATION_VERIFIED, so startWatching was not authorized for it.

BLOCKER CATEGORY
    environment / recovered-watch interference (TESTNET RPC 429), not a missing EventBus subscriber for OPEN_PAGE5
```

`BlockchainMonitor.start()` **did** run. The next defect is that global poll + recovery watches on a stale deposit, plus 3s activation retries, exhausted TonCenter and prevented verification/watch of the live room.

## 28. Source changes

```
server/app.js
  after setDepositMonitor: await this._blockchainMonitor.start()

server/tests/blockchainMonitor.test.js
  initialize-only does not poll DepositMonitor; start() does

server/tests/blockchainMonitor.productionStart.r18s15.test.js
  app.js source order: setDepositMonitor then start()
```

## 29. Focused tests

```
node tests/blockchainMonitor.test.js
  R18-S15 start() polls attached DepositMonitor: OK

node --test tests/blockchainMonitor.productionStart.r18s15.test.js
  1 pass
```

**AUTOMATED TEST VERIFIED.**

## 30. Commit SHA

```
40a2f8bbeda7d14f4e951834307f2d70a7d74cc7
40a2f8b R18-S15 start BlockchainMonitor so DepositMonitor poll runs
```

Pushed to `origin/main`.

## 31. Final Git state

```
HEAD 40a2f8bbeda7d14f4e951834307f2d70a7d74cc7
origin/main 40a2f8b
```

Untracked driver/report remain. No secrets committed.

---

## Stopping record

```
LAST VERIFIED STATE
    REAL PRODUCTION ROOM wMCC + PaymentSession + Deposit deploy/FundSeat broadcast + BlockchainMonitor STARTED

EXPECTED NEXT STATE
    DEPOSIT_ACTIVATION_VERIFIED (live deposit) → DEPOSIT_FULL_ONCHAIN → GAME_CONTRACT_DEPLOYED

EXACT OPERATION
    verifyActivation retry + DepositMonitor.poll

EXACT ERROR
    TonCenter 429; stale recovered watch dep_73d80824; live deposit never VERIFIED

RELEVANT FILE/FUNCTION
    BlockchainMonitor._pollGlobal / DepositOrchestrator._retryActivation / TonFinancialRecovery watches

RUNTIME EVIDENCE
    GAME_CONTRACT_DEPLOYED timeout (exit 9); no OPEN_PAGE5

BLOCKER CATEGORY
    environment + recovered deposit watch interference
```

Page5 is **not** reached. Next task should only: stop polling/retrying recovered Deposit sessions whose rooms are gone (or otherwise isolate live-room watches from stale recovery watches) so TESTNET RPC can verify the live deposit. Do not fabricate `OPEN_PAGE5`.

---

# LIVE TESTNET — STALE RECOVERY WATCH / TONCENTER 429 FIX

This section is a **new** production-stack run after commit `c1ec4a2`. It does **not** reuse room `wMCC` or deposit `dep_cacfeb7b-...` as proof. Earlier wMCC / JorV / L25 evidence above remains historical.

## 1. Starting HEAD

**SOURCE VERIFIED**

```
40a2f8bbeda7d14f4e951834307f2d70a7d74cc7
40a2f8b R18-S15 start BlockchainMonitor so DepositMonitor poll runs
```

Branch: `main`. That commit was **not** recreated.

## 2. Starting working tree

Dirty with pre-existing untracked reports, probes, sample banners, and the untracked driver `server/scripts/_r18s15_production_page5.mjs`. Production source at the start of this fix had no extra uncommitted monitor diffs beyond the files listed in §7.

## 3. Exact stale recovery Deposit

**SERVER RUNTIME VERIFIED (previous wMCC run, historical)**

```
dep_73d80824-279b-4fef-88da-178fbf1a6886
```

That deposit was the TonCenter poll target in the wMCC log while the live deposit was `dep_cacfeb7b-3c2a-4684-a986-6c8568637c65`.

## 4. Why it was considered stale/dead

**SOURCE VERIFIED**

`TonFinancialRecovery._restoreDepositMonitorWatches` calls `DepositActivationVerificationCoordinator.syncFromActiveSessions`, which re-verified **all** persisted `AWAITING_FUNDS` / `PARTIALLY_FUNDED` / `PLAYER_BINDING` sessions. Rooms are **not** restored into `RoomManager` on restart, so `dep_73d80824` had no live lobby room. Persistence still held the session. `BlockchainMonitor._pollGlobal` → `DepositMonitor.poll()` therefore kept calling TonCenter for that recovered watch.

Stopping poll does not discard on-chain funds. The session record remains.

## 5. Exact live Deposit (previous blocker run)

**SERVER RUNTIME VERIFIED (historical wMCC)**

```
dep_cacfeb7b-3c2a-4684-a986-6c8568637c65
EQB7Uxq9_UNof0s-TQ8uiof9GQa2n6a7SKmQVB0Ax_XrGZt9
```

## 6. Root cause of excessive polling

**SOURCE VERIFIED**

Two concurrent TonCenter consumers:

1. Recovered watch `dep_73d80824` via `BlockchainMonitor._pollGlobal` / `DepositMonitor.poll` (default 2s).
2. Live `DepositOrchestrator._retryActivation` → `verifyActivation` every 3s for `dep_cacfeb7b`.

TESTNET returned HTTP 429. The live deposit never reached `DEPOSIT_ACTIVATION_VERIFIED`.

## 7. Production source change

**SOURCE VERIFIED**

Commit `c1ec4a22f975f6fcc62c8c5351200c5f1369c64e`.

| File | Change |
|------|--------|
| `server/deposit/DepositMonitor.js` | Optional `roomManager`. `restoreActiveWatches` skips sessions whose room is gone. `poll()` prunes those watches before `blockchainSource.poll`. |
| `server/deposit/DepositActivationVerificationCoordinator.js` | Optional `roomManager`. `syncFromActiveSessions` skips dead-room sessions (no chain RPC). |
| `server/app.js` | Passes `this._managers.roomManager` into both. `BlockchainMonitor.start()` after `setDepositMonitor` is unchanged. |
| `server/deposit/RealTonDepositBlockchainSource.js` | Secondary: classify HTTP 429 as `rate_limited` and stop remaining watches in that poll cycle. The 429 is still logged. |

Existing `DepositOrchestrator` live-room retry skip is **preserved**. `BlockchainMonitor.start()` is **not** removed. No synthetic `DEPOSIT_ACTIVATION_VERIFIED` / `DEPOSIT_FULL_ONCHAIN`. No `authorizeVerifiedWatch` for the live deposit. Page4/Page5 untouched.

If `roomManager` is absent, previous behavior remains (tests without a lobby).

## 8. Focused tests

**AUTOMATED TEST VERIFIED**

```
node --test tests/depositMonitor.staleRecoveryWatch.r18s15.test.js
             tests/blockchainMonitor.productionStart.r18s15.test.js
             tests/depositOrchestrator.r179l23.test.js
             tests/depositActivationVerification.r179l22.test.js
             tests/depositMonitor.r179l7.test.js
```

**59 pass / 0 fail** (duration ~4.4s).

Including:

- Test A: dead-room recovered deposit is not continuously polled
- Test B: live-room recovered deposit remains eligible
- Test C: live watch is polled after a stale watch is pruned
- Test D: `app.js` still calls `BlockchainMonitor.start()` after `setDepositMonitor`, and passes `roomManager`
- Test E: live deposit still emits `DEPOSIT_FULL_ONCHAIN`; live-room `verifyActivation` still reaches `DEPOSIT_ACTIVATION_VERIFIED`
- Orchestrator WAITING retry test still passes
- 429 stops remaining watches in the same `poll()` cycle

```
node tests/blockchainMonitor.test.js
```

All assertions passed, including `R18-S15 start() polls attached DepositMonitor`.

## 9. Commit SHA

**SOURCE VERIFIED**

```
c1ec4a22f975f6fcc62c8c5351200c5f1369c64e
c1ec4a2 R18-S15 prune stale recovered Deposit watches to stop TonCenter 429
```

Pushed to `origin/main` (`40a2f8b..c1ec4a2`).

## 10. Fresh TESTNET roomId

**SERVER RUNTIME VERIFIED**

```
roomId=PNyS
tonNetwork=testnet
tonEndpoint=https://testnet.toncenter.com/api/v2/jsonRPC
deployMode=live
composition=WheelWinApplication app.js
serverUrl=http://127.0.0.1:3015
```

`TON_NETWORK=testnet` was verified before any transaction. Not MAINNET.

## 11. Fresh gameId

**SERVER RUNTIME VERIFIED**

```
gameId=game_75effc8b-a3cb-4901-8007-e42f3a6129dc
```

## 12. PaymentSession creation

**SERVER RUNTIME VERIFIED**

```
PAYMENT_CONNECTION_READY
[PaymentSessionManager] CREATED
paymentSessionId=pay_bfbb7097-9a0a-4081-96d0-09d1c1cc86d1
roomId=PNyS
gameId=game_75effc8b-a3cb-4901-8007-e42f3a6129dc
```

Not fabricated.

## 13. Deposit deployment

**REAL TESTNET VERIFIED**

```
depositId=dep_de72c833-99e4-4950-934b-c5494e257d78
depositAddress=EQAUewXoNLYxYZomGYtzr2Ef1ozdwj1P5LkKDJlu5weN8sIc
depositDeployTx=0ub3k2z/sC4Q3MwkSMZORlZjKC8pA9UdBO8p6xr1Sxc=
depositDeploySender=EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le
```

Deploy `sendBoc` HTTP 200, bocHash `f175e1644aa7b78535f50d345955a0f956eb9a272507689d5dca30347b002d23`.

Startup: `BlockchainMonitor started OK` at `2026-08-28T20:33:54.022Z`. No log line for recovered `dep_73d80824`. No `Deposit TON poll failed` for that stale id.

## 14. FundSeat transactions

**REAL TESTNET VERIFIED (broadcast). ON-CHAIN getters observed by production verifyActivation.**

Three `sendBoc` HTTP 200, 11_000_000 nanoTON each:

```
seat0 bocHash=9c41d05409c1f67b6b63e4143276e64bc9909bc7023d00499ad833c7203cf3fa
seat1 bocHash=303fad0ae7ba9a86a158a47e125f28543424ad99d576d81f707c40e3e7106596
seat2 bocHash=bcfb9ccc99453bb00f3e7f371f086ae732f23e995057192a6ce4008a0e30e06e
```

Driver printed `transactionHash=null` (hash not captured by the helper). Chain reads during activation retries reported `paidMask=7` and `totalCredited=33000000`.

## 15. DEPOSIT_ACTIVATION_VERIFIED

**NOT VERIFIED / BLOCKED**

Zero `DEPOSIT_ACTIVATION_VERIFIED` events for `dep_de72c833-...`.

After deploy, production emitted `DEPOSIT_ACTIVATION_WAITING` (UNINIT / waiting for player deploy). After FundSeat landed, retries emitted `DEPOSIT_ACTIVATION_REJECTED` with:

```
Initial mutable state mismatch
status=3, paidMask=7, creditedAmount0=11000000, creditedAmount1=11000000,
creditedAmount2=11000000, totalCredited=33000000
```

Path: `DepositOrchestrator._retryActivation` → `DepositActivationVerificationCoordinator.verifyActivation` → `assertInitialMutableState` (`server/payment/ton/readDepositGetters.js`).

Eight later retries also logged `Request failed with status code 429` on **this live** deposit (not `dep_73d80824`). Those 429s did not restore the stale-watch flood from the wMCC run.

## 16. DEPOSIT_FULL_ONCHAIN

**NOT VERIFIED / BLOCKED** — never emitted. Watch is authorized only after activation VERIFIED.

## 17. DEPLOY_AUTHORIZATION_VALID

**NOT VERIFIED / BLOCKED**

## 18. GameEscrow deployment

**NOT VERIFIED / BLOCKED** — no GameEscrow address. Do not treat earlier L25 READY escrow as this run.

## 19. INIT_GAME

**NOT VERIFIED / BLOCKED**

## 20. OPEN_PAYMENTS

**NOT VERIFIED / BLOCKED**

## 21. STAKE results

**NOT VERIFIED / BLOCKED**

## 22. paidMask

**ON-CHAIN VERIFIED (Deposit getters during activation retry, not GameEscrow)**

Deposit contract getters: `paidMask=7`. This is **Deposit** seat funding, not GameEscrow `paidMask`.

## 23. READY

**NOT VERIFIED / BLOCKED** — GameEscrow READY was not reached.

## 24. PAYMENT_SESSION_COMPLETED

**NOT VERIFIED / BLOCKED**

## 25. GAME_CONTRACT_PAYMENTS_COMPLETE

**NOT VERIFIED / BLOCKED**

## 26. GAME_START_AUTHORIZED

**NOT VERIFIED / BLOCKED**

## 27. GAME_START_BOOTSTRAP_READY

**NOT VERIFIED / BLOCKED**

## 28. ENTRY_PAYMENT_COMPLETED

**NOT VERIFIED / BLOCKED**

## 29. OPEN_PAGE5

**NOT VERIFIED / BLOCKED**

No `OPEN_PAGE5` from production `RoomLobbyBridge`.

## 30. Exact first blocker if not reached

The stale recovered watch / TonCenter 429 flood from `dep_73d80824` is **not** the remaining blocker. This fresh run's first concrete stop:

```
LAST VERIFIED STATE
    Production room PNyS; PaymentSession created; Deposit deployed;
    3 × FundSeat broadcast; Deposit getters paidMask=7 / totalCredited=33000000;
    BlockchainMonitor started; stale dep_73d80824 not polled

EXPECTED NEXT STATE
    DEPOSIT_ACTIVATION_VERIFIED → DEPOSIT_FULL_ONCHAIN → DEPLOY_AUTHORIZATION_VALID
    → GAME_CONTRACT_DEPLOYED

EXACT OPERATION
    DepositActivationVerificationCoordinator.verifyActivation
    → assertInitialMutableState

EXACT ERROR
    Initial mutable state mismatch | status=3, paidMask=7, totalCredited=33000000
    Driver then timed out waiting for GAME_CONTRACT_DEPLOYED (exit 9)

RELEVANT FILE/FUNCTION
    server/deposit/DepositActivationVerificationCoordinator.js
    (verifyActivation / assertInitialMutableState)
    server/payment/ton/readDepositGetters.js (assertInitialMutableState)

RUNTIME EVIDENCE
    DEPOSIT_ACTIVATION_WAITING then DEPOSIT_ACTIVATION_REJECTED for
    dep_de72c833-99e4-4950-934b-c5494e257d78
    First REJECT at 2026-08-28T20:34:55.697Z (totalCredited=11000000)
    Subsequent REJECT with paidMask=7 at 2026-08-28T20:35:03.560Z
    Zero DEPOSIT_ACTIVATION_VERIFIED / DEPOSIT_FULL_ONCHAIN / OPEN_PAGE5

BLOCKER CATEGORY
    application_code — activation gate requires empty initial mutable state;
    FundSeat already applied before VERIFIED, so retries cannot authorize the watch
```

Stopped here. Did not audit GameEscrow, PaymentSession completion, GameStartAuthorization, RoomLobbyBridge, Page4, or Page5.

## 31. Final Git state

**SOURCE VERIFIED**

```
HEAD = c1ec4a22f975f6fcc62c8c5351200c5f1369c64e
c1ec4a2 R18-S15 prune stale recovered Deposit watches to stop TonCenter 429
40a2f8b R18-S15 start BlockchainMonitor so DepositMonitor poll runs
7c30278 R18-S15 skip Deposit activation retries when the live room is gone
```

Production source files from this fix are committed and pushed. Working tree still has the same pre-existing untracked reports, probes, banners, and the untracked E2E driver. This report file is updated in the working tree.

---

# LIVE TESTNET — DEPOSIT ACTIVATION ORDERING FIX

This section is a **new** production-stack run after commit `1d41480`. It does **not** reuse room `PNyS` or deposit `dep_de72c833-...` as proof. The stale-recovery and PNyS sections above remain historical.

## 1. Starting HEAD

**SOURCE VERIFIED**

```
c1ec4a22f975f6fcc62c8c5351200c5f1369c64e
c1ec4a2 R18-S15 prune stale recovered Deposit watches to stop TonCenter 429
```

That production commit was **not** recreated or amended.

## 2. Starting Git state

Dirty with pre-existing untracked reports, probes, banners. Production monitor/activation source already on `c1ec4a2`. The E2E driver `server/scripts/_r18s15_production_page5.mjs` was untracked.

## 3. Exact E2E ordering bug

**SOURCE VERIFIED** (previous PNyS run was **SERVER RUNTIME VERIFIED**)

The runner did:

```
deploy Deposit (waitUntilActive)
    ↓
FundSeat × 3 immediately
    ↓
wait GAME_CONTRACT_DEPLOYED
```

It never waited for production `DEPOSIT_ACTIVATION_VERIFIED`. FundSeat therefore mutated the contract before `assertInitialMutableState()` could pass (`status=1`, `paidMask=0`).

## 4. Source / test-support file changed

**SOURCE VERIFIED**

No production activation-gate change. Files:

| File | Role |
|------|------|
| `server/scripts/_r18s15_production_page5.mjs` | E2E runner: wait for WAITING + matching VERIFIED before FundSeat |
| `server/tests/testnet/r18s15/depositActivationOrdering.js` | TEST-ONLY identity / FundSeat gate helpers |
| `server/tests/depositActivationOrdering.r18s15.test.js` | Focused ordering + gate-unchanged tests |

`assertInitialMutableState()` and `verifyActivation()` were not modified. `BlockchainMonitor.start()` was not modified.

## 5. Exact old ordering

```
DEPOSIT_PACKAGE_PUBLISHED
    ↓
player deploy Deposit
    ↓
FundSeat × 3
    ↓
verifyActivation sees funded state → REJECT
```

## 6. Exact corrected ordering

```
DEPOSIT_PACKAGE_PUBLISHED
    ↓
player deploy Deposit
    ↓
wait EventBus DEPOSIT_ACTIVATION_WAITING
    ↓
wait EventBus DEPOSIT_ACTIVATION_VERIFIED
    + persisted activationVerification.status=VERIFIED
      for the same roomId / gameId / depositId
    ↓
assertFundSeatAllowedAfterVerified
    ↓
FundSeat × 3
    ↓
wait DEPOSIT_FULL_ONCHAIN
    ↓
wait DEPLOY_AUTHORIZATION_VALID
    ↓
wait GAME_CONTRACT_DEPLOYED
```

## 7. Focused test results

**AUTOMATED TEST VERIFIED**

```
node --test tests/depositActivationOrdering.r18s15.test.js
             tests/blockchainMonitor.productionStart.r18s15.test.js
             tests/depositActivationVerification.r179l22.test.js
             tests/depositOrchestrator.r179l23.test.js
```

**52 pass / 0 fail.**

Including: FundSeat forbidden before matching VERIFIED; FundSeat allowed after match; driver source waits `WAIT_ACTIVATION_VERIFIED` before `await fundSeatAsPlayer`; `assertInitialMutableState` still rejects `status=3` / `paidMask=7`; L22 Tests 12–15 still REJECT funded/non-initial deposits; `BlockchainMonitor.start()` still after `setDepositMonitor`.

Commit: `1d41480b4cedad8ca115f7f416dd23360650adba` pushed to `origin/main`.

## 8. Fresh roomId

**SERVER RUNTIME VERIFIED**

```
roomId=GLSi
tonNetwork=testnet
tonEndpoint=https://testnet.toncenter.com/api/v2/jsonRPC
deployMode=live
composition=WheelWinApplication app.js
serverUrl=http://127.0.0.1:3015
```

`TON_NETWORK=testnet` verified before broadcast. Not MAINNET.

## 9. Fresh gameId

**SERVER RUNTIME VERIFIED**

```
gameId=game_079d1c9e-46ff-48c2-815b-f803f4000ee6
```

## 10. Fresh PaymentSession

**SERVER RUNTIME VERIFIED**

```
paymentSessionId=pay_efa52b24-c588-470e-9029-555ac1b2c7ae
roomId=GLSi
[PaymentSessionManager] CREATED after PAYMENT_CONNECTION_READY
```

## 11. Fresh Deposit

**REAL TESTNET VERIFIED**

```
depositId=dep_9c5f7ae8-d8ce-4d12-9a6c-a1867f90e1a4
depositAddress=EQCNvf1wjI1s-LjwXFZ9v7J0Fw-SSYD08HMIcizYAVcrzoUX
depositDeployTx=oB1FZMIYVve/VTY0YwZ/IrbXOzW04nrkTewOtYQvfbo=
depositDeploySender=EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le
deploy bocHash=ab829f6c85bdbdb688b700861c5dcd7535a97962171b22b7750655bab0e7d1ec
```

## 12. DEPOSIT_ACTIVATION_WAITING

**SERVER RUNTIME VERIFIED**

EventBus Type `DEPOSIT_ACTIVATION_WAITING` from `DepositActivationVerificationCoordinator` at `2026-08-28T21:02:46.716Z` (during/after deploy, before VERIFIED). Subscribers: 1 (orchestrator retry).

## 13. DEPOSIT_ACTIVATION_VERIFIED

**SERVER RUNTIME VERIFIED**

EventBus Type `DEPOSIT_ACTIVATION_VERIFIED` from `DepositActivationVerificationCoordinator` at `2026-08-28T21:03:05.594Z`. Persistence checkpoint for `dep_9c5f7ae8-...` immediately before the emit. Identity matched `roomId=GLSi`, `gameId=game_079d1c9e-...`, `depositId=dep_9c5f7ae8-...`.

## 14. Timestamp / order proving VERIFIED before FundSeat

**SERVER RUNTIME VERIFIED + REAL TESTNET VERIFIED**

| Step | Time (UTC) |
|------|------------|
| DEPOSIT_ACTIVATION_WAITING | 2026-08-28T21:02:46.716Z |
| DEPOSIT_ACTIVATION_VERIFIED | 2026-08-28T21:03:05.594Z |
| Driver FUNDSEAT phase | after that emit (fundSeatAfterVerified=true) |
| First FundSeat sendBoc | 2026-08-28T21:03:22 (bocHash `ca612e3a...`) |

No FundSeat BOC exists before `21:03:05.594Z`.

## 15. FundSeat transaction evidence

**REAL TESTNET VERIFIED** (sendBoc HTTP 200, 11_000_000 nanoTON each)

```
seat0 bocHash=ca612e3a1609d34a266edc9b4dbc432dc776ca4bb777916efbac2555325b48f4
seat1 bocHash=2caecdfe6cf2b26658eb9b05c30db39f61db5830fc0619e5f734a5bb99f07ba8
seat2 bocHash=783ae099dea896de569957bf44b78984981baf800a2c2e8b90f5ff678de2f4f8
```

## 16. Deposit paidMask

**SERVER RUNTIME VERIFIED** via `DEPOSIT_FULL_ONCHAIN` (three validated seat observations). Separate on-chain getter dump of Deposit `paidMask` after FULL was **not** re-queried in the driver. **ON-CHAIN VERIFIED: not independently re-read after FULL.**

## 17. DEPOSIT_FULL_ONCHAIN

**SERVER RUNTIME VERIFIED**

EventBus Type `DEPOSIT_FULL_ONCHAIN` from `DepositMonitor` at `2026-08-28T21:03:44.899Z`. Subscribers: 1.

## 18. DEPLOY_AUTHORIZATION_VALID

**SERVER RUNTIME VERIFIED**

EventBus Type `DEPLOY_AUTHORIZATION_VALID` from `DeploymentAuthorizationCoordinator` at `2026-08-28T21:03:44.947Z`. Subscribers: 1 (`GameContractManager`).

## 19. GameEscrow deployment

**REAL TESTNET VERIFIED + SERVER RUNTIME VERIFIED**

```
gameEscrowAddress=EQDjc5Lpf1QKopntBsw-mFAuE4aGK7fE5UQv1YZhMXPzJG11
contractId=contract_2fedaffc-9199-40de-a19b-5401a5b1ec8f
GAME_CONTRACT_DEPLOYED socket roomId=GLSi
TON GameContract deployed | mode=game
```

Deploy debug: `valueTon: 0.022`, endpoint testnet.toncenter.com.

## 20. INIT_GAME

**REAL TESTNET VERIFIED**

Adapter operation `INIT_GAME`, sendBoc HTTP path bocHash `e97f8d1580b91124f8788cd00dc6afcf7f146f992bc8b9d48c1fdcd0e2aa50d8`.

## 21. OPEN_PAYMENTS

**REAL TESTNET VERIFIED + SERVER RUNTIME VERIFIED**

Adapter operation `OPEN_PAYMENTS`, bocHash `fb086f4ba84b14f945c9a31c60356316f596231cbf20f25a2d17a4244f227beb`.

```
[GameContractManager] GAME_ESCROW_PAYMENTS_OPEN | roomId=GLSi | address=EQDjc5Lpf1QKopntBsw-mFAuE4aGK7fE5UQv1YZhMXPzJG11
GAME_CONTRACT_READY_FOR_PAYMENTS
PAYMENT_REQUESTS_ISSUED | address=EQDjc5Lpf1QKopnt...
paymentRequestCount=3
```

## 22. GameEscrow STAKE results

**REAL TESTNET VERIFIED** (broadcast ok=true, 1 TON / 1_000_000_000 nanoTON)

```
stake0 sender=EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le bocHash=3231880381bb0dce7ff4f8e0197076e5d1ef667db1c4d287db61e09e480952f9
stake1 sender=EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp bocHash=980454e752b5cb79b4a3cf21baa0ff4495df99a0ee401646763f2f1c7bbb6591
stake2 sender=EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM bocHash=4e8ee1d9b8c68e123d58ba0e1c5ed27ccecce447d1bbf5d2be3033bb23a69ff7
```

## 23. GameEscrow paidMask

**SERVER RUNTIME VERIFIED** via production `GAME_CONTRACT_PAYMENTS_COMPLETE` / payment confirmation (BlockchainMonitor). Driver `get_paid_mask` after STAKE threw TonCenter HTTP 429 (**NOT VERIFIED** as a post-hoc getter print). Production still treated payments complete.

## 24. GameEscrow READY

**SERVER RUNTIME VERIFIED** as payments-complete / game-start path (`GAME_ESCROW_PAYMENTS_OPEN` then `GAME_CONTRACT_PAYMENTS_COMPLETE` then `CONTRACT_READY`). Independent `get_status` getter after STAKE: **NOT VERIFIED** (same driver 429).

## 25. PAYMENT_SESSION_COMPLETED

**SERVER RUNTIME VERIFIED**

Socket `PAYMENT_SESSION_COMPLETED` for `roomId=GLSi`, `gameId=game_079d1c9e-...`. EventBus Type `PAYMENT_SESSION_COMPLETED` at `2026-08-28T21:06:03.117Z`.

## 26. GAME_CONTRACT_PAYMENTS_COMPLETE

**SERVER RUNTIME VERIFIED**

EventBus Type `GAME_CONTRACT_PAYMENTS_COMPLETE` at `2026-08-28T21:06:03.133Z`.

## 27. GAME_START_AUTHORIZED

**SERVER RUNTIME VERIFIED**

```
[GameStartAuthorization] GAME_START_AUTHORIZED | roomId=GLSi | gameId=game_079d1c9e-46ff-48c2-815b-f803f4000ee6
```

EventBus Type `GAME_START_AUTHORIZED` at `2026-08-28T21:06:03.135Z`.

## 28. GAME_START_BOOTSTRAP_READY

**SERVER RUNTIME VERIFIED**

```
[GameStartAuthorization] GAME_START_BOOTSTRAP_READY | roomId=GLSi | gameId=game_079d1c9e-46ff-48c2-815b-f803f4000ee6
```

EventBus Type `GAME_START_BOOTSTRAP_READY` at `2026-08-28T21:06:03.146Z`.

## 29. ENTRY_PAYMENT_COMPLETED

**SERVER RUNTIME VERIFIED**

EventBus Type `ENTRY_PAYMENT_COMPLETED` from `RoomLobbyBridge` at `2026-08-28T21:06:03.148Z`.

```
[GameplayBootstrap] ENTRY_PAYMENT_COMPLETED — activating gameplay | roomId=GLSi
```

## 30. OPEN_PAGE5

**SERVER RUNTIME VERIFIED**

Production `RoomLobbyBridge` delivered `OPEN_PAGE5` to all three seats for `roomId=GLSi`:

```
socketEvent seat=p0 event=OPEN_PAGE5 roomId=GLSi
socketEvent seat=p1 event=OPEN_PAGE5 roomId=GLSi
socketEvent seat=p2 event=OPEN_PAGE5 roomId=GLSi
```

Followed by `LOBBY_SOCKET_DELIVERY` from `RoomLobbyBridge`. Not fabricated. Page4/Page5 client code was not modified.

The E2E process later exited 1: uncaught TonCenter HTTP 429 on the driver's post-STAKE `get_paid_mask` / `get_status` read. That is **after** `OPEN_PAGE5`. It is not a production Page5 blocker.

## 31. Exact first blocker if Page5 was not reached

**Not applicable.** `OPEN_PAGE5` was reached.

## 32. Final Git state

**SOURCE VERIFIED**

```
HEAD = 1d41480b4cedad8ca115f7f416dd23360650adba
1d41480 R18-S15 wait for Deposit activation VERIFIED before E2E FundSeat
c1ec4a2 R18-S15 prune stale recovered Deposit watches to stop TonCenter 429
40a2f8b R18-S15 start BlockchainMonitor so DepositMonitor poll runs
```

`c1ec4a2` remains intact. No production activation-gate commit. Report file updated in the working tree.

---

# LIVE TESTNET — GAMEESCROW READY TO PRODUCTION PAGE5

Date: 2026-08-28  
Classification of **this** continuation: **R18_S15_BLOCKED** at `GAME_CONTRACT_DEPLOYED`  
This section is a new fresh TESTNET run. It does **not** reuse GLSi / PNyS / wMCC evidence.

## 1. Starting HEAD

**SOURCE VERIFIED**

```
adcc0876f7c33caca0f5e682532f6da8189d236b
adcc087 docs: record R18-S15 Deposit activation ordering and OPEN_PAGE5
1d41480 R18-S15 wait for Deposit activation VERIFIED before E2E FundSeat
c1ec4a2 R18-S15 prune stale recovered Deposit watches to stop TonCenter 429
40a2f8b R18-S15 start BlockchainMonitor so DepositMonitor poll runs
```

`40a2f8b`, `c1ec4a2`, and `1d41480` remain intact. No reset, rebase, force-push, or amend.

## 2. Starting Git status

**SOURCE VERIFIED**

Dirty tree at start of this continuation: modified `server/scripts/_r18s15_production_page5.mjs` (in-progress READY-to-Page5 runner wait), plus pre-existing untracked reports, probes, banners, and session artifacts. Production `app.js` / Page4 / Page5 / DepositContract / GameEscrow FunC were not modified.

## 3. Exact reason the previous runner stopped at READY

**SOURCE VERIFIED** (historical; not this run)

Two different stop reasons existed:

1. Earlier S15 getter/STAKE runners treated on-chain `get_status = READY` as the terminal proof and exited without waiting on the production lobby/game-start EventBus.
2. The production `app.js` lobby runner that reached room `GLSi` **did** subscribe to `OPEN_PAGE5`, but after STAKE it called `get_paid_mask` / `get_status` **before** awaiting that socket event. An uncaught TonCenter HTTP 429 aborted the process (`exit 1`) so `page5Reached=true` was never logged. Production `RoomLobbyBridge` had already delivered `OPEN_PAGE5` for `GLSi` (see the previous section). That GLSi evidence is **not** reused as proof for this fresh run.

The actual gap for the READY-to-Page5 milestone was therefore the **E2E runner**, not a missing second architecture.

## 4. Production component responsible for the next transition after GameEscrow READY

**SOURCE VERIFIED**

`BlockchainMonitor` observes GameEscrow STAKE and emits `GAME_ESCROW_STAKE_CONFIRMED`.  
`PaymentSessionManager` consumes that observation, marks the session completed, and emits `PAYMENT_SESSION_COMPLETED`.

No new event was invented. No parallel EventBus or manager copies were created.

## 5. Exact event/handoff discovered

**SOURCE VERIFIED**

Real source → consumer (existing production composition in `app.js`):

| Event | Source | Consumer |
|---|---|---|
| `GAME_ESCROW_STAKE_CONFIRMED` | `BlockchainMonitor` | `PaymentSessionManager` (`_handlePaymentTransactionConfirmed`) |
| `PAYMENT_SESSION_COMPLETED` | `PaymentSessionManager` | `GameContractManager._handlePaymentSessionCompleted`; `GameStartAuthorization._evaluate`; `RoomLobbyBridge` (socket delivery) |
| `GAME_CONTRACT_PAYMENTS_COMPLETE` | `GameContractManager.markPaymentsComplete` | `GameStartAuthorization._evaluate` |
| `GAME_START_AUTHORIZED` | `GameStartAuthorization._authorizeAndBootstrap` | `RoomLobbyBridge._deliverGameStartAuthorized` |
| `GAME_INITIALIZING` | `GameStartAuthorization._authorizeAndBootstrap` | `RoomLobbyBridge._deliverGameInitializing` |
| `GAME_START_BOOTSTRAP_READY` | `GameStartAuthorization._authorizeAndBootstrap` | `RoomLobbyBridge._handleGameStartBootstrapReady` |
| `ENTRY_PAYMENT_COMPLETED` | `RoomLobbyBridge._completeEntryPayment` | gameplay bootstrap; then `_deliverOpenPage5` |
| `OPEN_PAGE5` | `RoomLobbyBridge._deliverOpenPage5` | lobby sockets `{ roomId }` |

`GameStartAuthorization` also records audit type `OPEN_PAGE5` internally; the authoritative client signal is the socket event from `RoomLobbyBridge`. The runner does **not** call `_deliverOpenPage5` and does **not** emit these events.

## 6. E2E runner change

**SOURCE VERIFIED**

File: `server/scripts/_r18s15_production_page5.mjs`

- After STAKE, phase `WAIT_PRODUCTION_PAGE5`. GameEscrow READY getters are **not** terminal.
- Socket waits for `OPEN_PAGE5` / `PAYMENT_SESSION_COMPLETED` / `GAME_START_AUTHORIZED` / `GAME_INITIALIZING` / `ENTRY_PAYMENT_COMPLETED` require `payload.roomId ===` the live room.
- Production log observation for the same events starts **before** STAKE broadcasts and correlates `EventName` + `roomId`.
- `await openPage5` runs **before** optional on-chain getters, so a TonCenter 429 on `get_paid_mask` / `get_status` cannot abort the Page5 wait.
- Getter failures are caught; they do not `process.exit`.

## 7. Production source change

**SOURCE VERIFIED**

None. The READY-to-Page5 production chain already exists. This continuation did not modify Page4, Page5, DepositContract, GameEscrow, PaymentSessionManager, GameStartAuthorization, RoomLobbyBridge, or GameContractManager.

## 8. Focused test results

**AUTOMATED TEST VERIFIED** (commands actually executed)

```
node --test tests/r18s15.page5Continuation.r18s15.test.js
  passed=2  failed=0  skipped=0
```

Combined `node --test` of:

- `tests/r18s15.page5Continuation.r18s15.test.js`
- `tests/depositActivationOrdering.r18s15.test.js`
- `tests/gameContract.deployAuthorizationHandoff.r18s15.test.js`
- `tests/blockchainMonitor.productionStart.r18s15.test.js`

```
passed=16  failed=0  skipped=0
```

(the 16 includes the 2 continuation tests)

```
node tests/gameStartAuthorization.test.js
  passed (script: "gameStartAuthorization.test.js passed")
  failed=0  skipped=0
```

```
node tests/paymentSession.manager.test.js
  passed (script: "paymentSession.manager.test.js: all assertions passed")
  failed=0  skipped=0
```

```
node tests/gameContract.manager.test.js
  passed (script: "gameContract.manager.test.js: all assertions passed")
  failed=0  skipped=0
  (process left open handles after assertions; not a failed assertion)
```

```
node tests/roomLobby.integration.test.js
  passed=0  failed=1  skipped=0
  Error: Timed out waiting for roomCreated
```

`roomLobby.integration.test.js` uses a harness socket **without** Telegram `initData`. Production `RoomLobbyBridge._handleCreateRoom` rejects web sockets (`ROOM_CREATION_REQUIRES_TELEGRAM`). That failure is pre-existing relative to this runner change. It was not used as READY-to-Page5 proof. The Telegram-authenticated production runner is the E2E below.

## 9. Fresh roomId

**SERVER RUNTIME VERIFIED**

`pyzv`  
Not PNyS / wMCC / GLSi.

## 10. Fresh gameId

**SERVER RUNTIME VERIFIED**

`game_d12083ca-02da-4d4a-86d9-5db748fc3604`

## 11. Fresh PaymentSession

**SERVER RUNTIME VERIFIED**

`pay_294144b3-1be3-4d70-b53d-7a9f5200db59`

## 12. Fresh Deposit

**SERVER RUNTIME VERIFIED** / **REAL TESTNET VERIFIED**

- `depositId=dep_61b126c3-dd8e-4ed5-b97c-4b728fde5d5e`
- `depositAddress=EQCGxOkujyANhwe_FzbXlyqhKH3BEjYPJDUXOwXhe0P9H0ye`
- deploy BOC success on `https://testnet.toncenter.com/api/v2/jsonRPC`
- `depositDeployTx=9twJOKZvPJBVj+ATrympnM/tWvsUd90DP9SCoQ2T9oE=`
- `depositDeploySender=EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le`

Network at start of runner:

```
tonNetwork=testnet
tonEndpoint=https://testnet.toncenter.com/api/v2/jsonRPC
deployMode=live
```

`TON_MAINNET_READINESS` logged `status: FAIL` / `activeNetwork: testnet`. No MAINNET broadcast.

## 13. Deposit activation

**SERVER RUNTIME VERIFIED**

- EventBus `DEPOSIT_ACTIVATION_WAITING` at `2026-08-28T21:35:04.451Z` (driver `depositActivationWaitingAt=1787952911902`)
- `DEPOSIT_ACTIVATION_VERIFIED` EventBus `2026-08-28T21:35:22.691Z` from `DepositActivationVerificationCoordinator`
- verified identities: `depositId=dep_61b126c3-...` `roomId=pyzv` `gameId=game_d12083ca-...`
- FundSeat started only after that matching VERIFIED (`fundSeatAfterVerified=true`)

A transient `DEPOSIT_ACTIVATION_REJECTED` / `activation retry failed` 429 occurred at `21:35:14.707Z` and was **not** treated as success. VERIFIED followed at `21:35:22.691Z`.

## 14. FundSeat results

**REAL TESTNET VERIFIED**

All three seats `valueNano=11000000` via TESTNET `sendBoc`:

| Seat | bocHash |
|---|---|
| 0 | `e5a212a34dbe287e06ad668a5f779d1fbf89f6509c97e48b771803cccc71a2a9` |
| 1 | `3d806039207063719291fc8994cfabecbb8127445541e3639cf4f4a45d758145` |
| 2 | `9efff1b2d7606577aa42ac92f601eae3074129baf66fa0781fe81baecf560e37` |

Driver `transactionHash` fields were null (hash is in the BOC logs above).

## 15. Deposit full state

**SERVER RUNTIME VERIFIED**

`DEPOSIT_FULL_ONCHAIN` / `DEPOSIT_FULL` at `2026-08-28T21:35:46.122Z`–`21:35:46.156Z`.

## 16. Deployment authorization

**SERVER RUNTIME VERIFIED**

`DEPLOY_AUTHORIZATION_VALID` at `2026-08-28T21:35:46.176Z`.  
`GameContractManager.createContractRequest` then `_beginDeploy` for `contract_51c420c9-0d04-487f-ac94-71b25c13e190` / room `pyzv`.

## 17. Fresh GameEscrow address

**NOT VERIFIED** / **BLOCKED**

No GameEscrow address was produced for `pyzv`. Deploy failed before broadcast completed.

## 18. INIT_GAME

**NOT VERIFIED** — blocked before GameEscrow deploy success.

## 19. OPEN_PAYMENTS

**NOT VERIFIED** — blocked before GameEscrow deploy success.

## 20. STAKE × 3

**NOT VERIFIED** — blocked before GameEscrow deploy success.

## 21. GameEscrow paidMask

**NOT VERIFIED**

## 22. GameEscrow READY

**NOT VERIFIED**

This fresh run did not reach on-chain READY. Historical GLSi `paidMask=7` / `get_status=5` is **not** counted here.

## 23. PAYMENT_SESSION_COMPLETED

**NOT VERIFIED** for `pyzv`.

Observed instead: socket `PAYMENT_SESSION_FAILED` for `roomId=pyzv` / `gameId=game_d12083ca-...` / `pay_294144b3-...` after deploy failure (`status: PAYMENT_FAILED`).

## 24. GAME_CONTRACT_PAYMENTS_COMPLETE

**NOT VERIFIED**

## 25. GAME_START_AUTHORIZED

**NOT VERIFIED**

## 26. GAME_START_BOOTSTRAP_READY

**NOT VERIFIED**

## 27. ENTRY_PAYMENT_COMPLETED

**NOT VERIFIED**

## 28. OPEN_PAGE5

**NOT VERIFIED** / **BLOCKED**

Driver exit 9:

```
status=BLOCKED
lastVerified=DEPLOY_AUTHORIZATION_VALID
nextExpected=GAME_CONTRACT_DEPLOYED
reason=timeout waiting for GAME_CONTRACT_DEPLOYED
```

## 29. Exact first blocker if Page5 was not reached

```
LAST VERIFIED STATE: DEPLOY_AUTHORIZATION_VALID
EXPECTED NEXT STATE: GAME_CONTRACT_DEPLOYED
EXACT OPERATION: TonGameContractAdapter._broadcastDeploy → _sendOracleMessage → getSeqno
EXACT ERROR: AxiosError HTTP 429 from TESTNET TonCenter during deployer seqno read
RELEVANT FILE/FUNCTION: server/payment/TonGameContractAdapter.js (_sendOracleMessage ~1486; _broadcastDeploy ~1336); server/payment/ton/gameContract/legacyTonServiceShim.js getSeqno
EVENT THAT WAS EXPECTED: GAME_CONTRACT_DEPLOYED (then INIT_GAME / OPEN_PAYMENTS / STAKE / READY / PAYMENT_SESSION_COMPLETED / OPEN_PAGE5)
EVENT THAT WAS ACTUALLY OBSERVED: GAME_CONTRACT_DEPLOY_FAILED + PAYMENT_SESSION_FAILED for room pyzv
ROOM/GAME/SESSION ID: roomId=pyzv gameId=game_d12083ca-02da-4d4a-86d9-5db748fc3604 paymentSessionId=pay_294144b3-1be3-4d70-b53d-7a9f5200db59 depositId=dep_61b126c3-dd8e-4ed5-b97c-4b728fde5d5e contractId=contract_51c420c9-0d04-487f-ac94-71b25c13e190
BLOCKER CATEGORY: TonCenter rate limit on GameEscrow deploy seqno (not PaymentSessionManager, not GameStartAuthorization, not RoomLobbyBridge, not Page4/Page5)
```

Production log:

```
TON_DEPLOY_EXCEPTION_DETAILS
AxiosError: Request failed with status code 429
    at async Object.getSeqno (.../legacyTonServiceShim.js:57)
    at async TonGameContractAdapter._sendOracleMessage (.../TonGameContractAdapter.js:1486)
    at async TonGameContractAdapter._broadcastDeploy (.../TonGameContractAdapter.js:1336)
TON GameContract deploy failed | Request failed with status code 429
Stage: DEPLOY_RESULT | Decision: FAILED | Reason: Adapter Result failed; reason=deploy_failed
Next Action: GAME_CONTRACT_DEPLOY_FAILED
```

This is **not** a READY-to-lobby handoff defect. The production Page5 chain was never entered because GameEscrow never deployed. Per task rules, 429 was not re-audited or redesigned in this continuation.

DepositMonitor already classified live-deposit 429 as `kind=rate_limited` and stopped remaining watches that cycle; the deploy path `getSeqno` is a **separate** call and is fail-closed today.

## 30. Final Git state

Recorded after the commit of this continuation (see §31). Working tree besides the committed runner/test/report remains dirty with unrelated untracked files.

## 31. Commit SHA if a commit was created

Pending at report-write time; filled after `git commit` of:

- `server/scripts/_r18s15_production_page5.mjs`
- `server/tests/r18s15.page5Continuation.r18s15.test.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-28_r18_s15_server_gameescrow_to_page5_e2e_report.md`

No production lifecycle source in this commit. No secrets, `.env`, or probe files.



