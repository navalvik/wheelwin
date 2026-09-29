# Stage 2 — Minimal recoveryCredential Repair (SETUP_SESSION_SYNC re-issue path)

Date: 2026-09-27

Task: Implement ONLY the recoveryCredential repair identified in
`AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1_recovery_identity_inspection.md`:
(1) client-side `credentialPresent` diagnostic, (2) fresh credential re-issue on
the already-authorized private `SETUP_SESSION_SYNC` delivery path, (3) client
persistence through the existing `PlayerIdentityContext` setter, (4) smallest
relevant tests. No redesign of recovery, no payment/VERIFY/
GameStartAuthorization/Room Wallet/TON changes. Nothing committed or pushed.

---

## 1. Scope

- Server: `RoomLobbyBridge._deliverSetupSessionSync` only — the
  requester-scoped private delivery path used by `_handleCreateRoom` and
  `_handleJoinRoom` on a socket just bound by the server-owned socket→player
  binding.
- Client: `RecoveryExperienceContext.jsx` — request trace diagnostic and
  `onSetupSessionSync` persistence.
- Tests: one new server test file, one new client test file.
- Explicitly untouched: `SocketGateway._handleRecoveryRequest`,
  `reconnectSession()` authorization, `authorizeRecoveryCredential()`,
  `RecoveryCredentialStore.validate()`, the room-wide archived
  SETUP_SESSION_SYNC broadcast in `_broadcastPaymentStageReady`, the inline
  SYNC delivery inside `reconnectSession()`, PaymentSessionManager, VERIFY
  logic, GameStartAuthorization, Room Wallet, TON/smart-contract code.

## 2. Files Inspected

Context (per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1_recovery_identity_inspection.md`

Implementation targets:

- `server/socket/RoomLobbyBridge.js` — `_deliverSetupSessionSync` (8173),
  call sites `_handleCreateRoom` (1365) / `_handleJoinRoom` (2284),
  `issueRecoveryCredential` (2677), `authorizeRecoveryCredential` (2686),
  `reconnectSession` (2707), `_getSocketContext` (7746), `_deliverToSocket`
  (8484), other SYNC delivery points (2974 reconnect inline, 5457 room-wide).
- `server/gameplay/RecoveryCredentialStore.js` — `issue` returns plaintext
  once and replaces the stored hash; `validate` returns
  `RECOVERY_AUTH_REASONS.MISSING` for null/empty credentials.
- `server/gameplay/SetupSessionLifecycle.js` — `buildSyncPayload` (849).
- `server/models/SetupSession.js` — `toSnapshot` (261) returns an
  `Object.freeze(...)` snapshot (no `playerId` field) — hence the delivered
  payload must be a derived copy, not a mutation.
- `client/src/context/RecoveryExperienceContext.jsx` — `recoveryTrace` (82),
  `requestSessionRecovery` (165–196), `onSetupSessionSync` (784–797).
- `client/src/context/PlayerIdentityContext.jsx` — `setIdentity` merge
  semantics + sessionStorage write (`wheelwin.setupRecoveryIdentity`).
- `client/src/providers/GameEngineProviders.jsx` / `client/src/App.jsx` —
  confirmed `RecoveryExperienceProvider` (and therefore the
  `SETUP_SESSION_SYNC` listener) is mounted across the whole game flow,
  including LOBBY, so create/join-time delivery is ingestible.
- Test-pattern references: `server/tests/identityRecovery.r131e.test.js`,
  `server/tests/depositProtectedReconnect.r18s16.test.js`,
  `client/src/components/HeaderBar.mainnetHandoff.test.js` (source-scan
  pattern, because the Node client harness has no JSX loader).

## 3. Architecture Findings / Exact Repair Implemented

### 3.1 Server — `server/socket/RoomLobbyBridge.js` (`_deliverSetupSessionSync`)

`buildSyncPayload` returns a frozen snapshot without `playerId`, so the repair
derives the bound player from the authoritative socket binding
(`_getSocketContext(socketId)` → `{ socketId, playerId, roomId }` from the
server-owned `_socketToPlayer` map + `PlayerManager` runtime) and issues a
fresh credential only when `socketContext.roomId === roomId`:

```js
const socketContext = this._getSocketContext(socketId);

let deliveryPayload = syncPayload;

if (socketContext && socketContext.roomId === roomId) {

    const recoveryCredential = this.issueRecoveryCredential(
        socketContext.playerId,
        roomId
    );

    if (recoveryCredential) {

        deliveryPayload = {
            ...syncPayload,
            recoveryCredential
        };

        this._logger.info(
            `[R6.2A Recovery] recoveryCredential re-issued`
            + ` | roomId=${roomId}`
            + ` | playerId=${socketContext.playerId}`
            + ` | socket.id=${socketId}`
        );

    }

}

this._deliverToSocket(
    socketId,
    LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC,
    deliveryPayload
);
```

Properties of the repair:

- Uses the EXISTING issuance mechanism (`issueRecoveryCredential` →
  `RecoveryCredentialStore.issue`); no parallel store, no new events, no
  protocol change (the payload gains an additive field on a private path).
- Exposes a plaintext credential ONLY on the already-authorized private path
  (socket bound to this exact room). Unbound sockets and sockets bound to a
  different room receive the payload without a `recoveryCredential` key.
- The room-wide archived broadcast (`_broadcastPaymentStageReady`) and the
  inline reconnect delivery in `reconnectSession()` do NOT go through
  `_deliverSetupSessionSync` and remain credential-free / unchanged.
- `issue()` replaces the prior hash; at create/join the client ingests
  ROOM_CREATED/ROOM_JOINED credential first, then the newer SYNC credential,
  so the final client-side plaintext always matches the newest stored hash
  (socket.io preserves per-socket ordering).

### 3.2 Client — `client/src/context/RecoveryExperienceContext.jsx`

1. `recoveryTrace(stage, { roomId, playerId, credentialPresent })` — the field
   is printed only when explicitly provided as a boolean, so every other trace
   line stays byte-identical.
2. `requestSessionRecovery()` trace now includes
   `credentialPresent: Boolean(identity.recoveryCredential)`. The emitted
   `SESSION_RECOVERY_REQUEST` payload is unchanged
   (`recoveryCredential: identity.recoveryCredential ?? null`).
3. `onSetupSessionSync(payload)` — if `payload?.recoveryCredential` is present,
   persists it merge-only via the EXISTING setter:
   `setIdentity({ recoveryCredential: payload.recoveryCredential })`.
   `roomId`/`playerId`/`gameId` are never replaced or cleared; no localStorage;
   no new storage mechanism; `setIdentity` (a stable `useCallback([])`) added
   to the socket-effect dependency array.

Resulting flow: authoritatively bound session → SETUP_SESSION_SYNC → fresh
recoveryCredential → `PlayerIdentityContext.setIdentity()` → sessionStorage.

## 4. Lifecycle Flow (after repair)

```text
CREATE / JOIN (seat birth)
  server: issueRecoveryCredential() → ROOM_CREATED / ROOM_JOINED plaintext
  server: _deliverSetupSessionSync()
            └─ socket authoritatively bound to this room?
                 yes → re-issue fresh credential → SYNC payload carries it
                 no  → SYNC payload unchanged (no credential key)
  client: roomCreated/roomJoined → setIdentity(credential C1)
  client: onSetupSessionSync → setIdentity({ recoveryCredential: C2 })
          → sessionStorage("wheelwin.setupRecoveryIdentity")

RELOAD / UNBOUND RECLAIM (unchanged, fail-closed)
  requestSessionRecovery() traces credentialPresent=true/false
  emit SESSION_RECOVERY_REQUEST {recoveryCredential ?? null}
  server authorizeRecoveryCredential → missing/invalid → RECOVERY_AUTH_MISSING
  (reconnectSession rules unchanged; credential still required)
```

## 5. Ownership Boundaries

- Credential issuance/validation owner (server): `RecoveryCredentialStore` via
  `RoomLobbyBridge` — reused, not duplicated.
- Sync delivery owner (server): `RoomLobbyBridge._deliverSetupSessionSync` —
  the only touched server function.
- Recovery identity storage owner (client): `PlayerIdentityContext` — the only
  writer used (`setIdentity`).
- Recovery flow owner (client): `RecoveryExperienceContext` — the only handler
  touched.
- No authority moved between server and client; the credential remains a
  server-issued ownership proof (R13.1E).

## 6. Tests / Checks Executed and Results

New tests (smallest relevant set only):

- `server/tests/setupSessionSyncCredentialRepair.r179t7.test.js` (new,
  `node:test`, buildStack + `eventBus.subscribe(LOBBY_SOCKET_DELIVERY)`
  capture):
  1. (A) bound socket → SETUP_SESSION_SYNC payload carries a fresh, non-empty
     `recoveryCredential` that validates via the unchanged
     `authorizeRecoveryCredential`; snapshot fields preserved; superseded
     prior credential no longer validates (re-issue semantics).
  2. (A-negative) unbound socket and cross-room-bound socket → payload carries
     NO `recoveryCredential`.
  3. (C) `reconnectSession` with a playerId claim and missing credential →
     rejected with the unchanged denial reason; `authorizeRecoveryCredential`
     reason stays `RECOVERY_AUTH_MISSING`.
- `client/src/context/RecoveryExperienceContext.setupSyncCredentialRepair.test.js`
  (new; follows the established `HeaderBar.mainnetHandoff.test.js`
  source-scan + verbatim-evaluation pattern, because the Node client harness
  has no JSX loader):
  1. (B) credential present → exactly one `setIdentity` call whose partial is
     EXACTLY `{ recoveryCredential: <value> }` (merge-only; no
     roomId/playerId/gameId keys).
  2. absent / empty credential or null payload → no identity write.
  3. setup-completion behaviour on a setup-recovery page unchanged.
  4. structural: request trace includes
     `credentialPresent: Boolean(identity.recoveryCredential)`; request
     protocol field unchanged; `setIdentity` destructured from
     `usePlayerIdentity()`; no `localStorage`.

Commands and results:

| Command | Result |
| --- | --- |
| `node --check server/socket/RoomLobbyBridge.js` | exit 0 |
| `node server/tests/setupSessionSyncCredentialRepair.r179t7.test.js` | tests 3, pass 3, fail 0 (exit 0) |
| `node server/tests/identityRecovery.r131e.test.js` | "R13.1E identity recovery credential tests passed" (exit 0) |
| `node server/tests/setupSession.reconnect.test.js` | "all assertions passed" (exit 0) |
| `node --import client/scripts/register.js client/src/context/RecoveryExperienceContext.setupSyncCredentialRepair.test.js` | "tests passed" (exit 0) |
| `node --import client/scripts/register.js client/src/game/sessionRecovery/recoveryFlow.test.js` | "all assertions passed" (exit 0) |
| `npx eslint src/context/RecoveryExperienceContext.jsx` (client) | 4 problems — ALL pre-existing (see §8) |

Unrelated pre-existing failure observed (NOT caused by this stage, NOT fixed):

- `node server/tests/roomLobby.integration.test.js` →
  `Error: Timed out waiting for roomCreated` (exit 1). Verified pre-existing:
  with this stage's `server/socket/RoomLobbyBridge.js` change temporarily
  stashed (`git stash push -- server/socket/RoomLobbyBridge.js`), the test
  failed identically at HEAD state; the stash was popped and the working tree
  restored (verified via `git status`). The test boots a real socket.io server
  and times out waiting for the ROOM_CREATED event in this environment; it is
  unrelated to the credential repair (ROOM_CREATED delivery is untouched and
  precedes SYNC delivery).

## 7. Confirmation of Non-Weakening

- **Unbound recovery authorization NOT weakened:** `reconnectSession()`
  (server/socket/RoomLobbyBridge.js) and `authorizeRecoveryCredential()` /
  `RecoveryCredentialStore.validate()` are byte-identical to HEAD. Test 3 of
  the new server test proves a missing credential is still rejected with
  `RECOVERY_AUTH_MISSING`; `identityRecovery.r131e.test.js` (all boundary
  cases) still passes.
- **No credential exposed through any unbound path:** test 2 of the new server
  test proves unbound / cross-room sockets receive a SYNC payload without a
  credential key.
- **No payment behavior changes:** no payment module touched
  (`server/gameplay/PaymentSessionManager.js` retains ONLY its pre-existing
  working-tree modification; this stage made no edits to it).
- **No VERIFY behavior changes:** no VERIFY code path touched.
- **No GameStartAuthorization changes:** untouched.
- **No Room Wallet changes:** untouched.
- **No TON / smart-contract code introduced:** none.
- **No new recovery events;** `reconnectSession` credential requirements not
  relaxed; identity remains in sessionStorage via the existing mechanism (no
  localStorage).

## 8. Changes Made

Files changed by this stage (verified with `git diff`):

1. `server/socket/RoomLobbyBridge.js` — `_deliverSetupSessionSync` only
   (41 insertions / 1 deletion region): authoritative-binding check + fresh
   credential re-issue + derived delivery payload + one info log line.
2. `client/src/context/RecoveryExperienceContext.jsx` — `recoveryTrace`
   optional `credentialPresent`, request-trace diagnostic, `setIdentity`
   destructure, `onSetupSessionSync` merge-only persistence, dependency array
   (34 insertions / 4 deletions region).
3. `server/tests/setupSessionSyncCredentialRepair.r179t7.test.js` (new).
4. `client/src/context/RecoveryExperienceContext.setupSyncCredentialRepair.test.js`
   (new).
5. This report: `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage2_recovery_credential_repair.md`.

Pre-existing working-tree state observed and left untouched (git status at
HEAD `53fe3ba8c7f45d5d13ebfcc434f89e7de2493be3`):

- Modified: `server/gameplay/PaymentSessionManager.js` (pre-existing; NOT part
  of this stage; not modified here).
- Untracked pre-existing reports:
  `2026-09-27_gameescrow_depositcontract_remaining_links_analysis.md`,
  `2026-09-27_payment_session_restore_room_wallet_refund_gap.md`,
  `2026-09-27_setup_session_restart_rearm_analysis.md`,
  `2026-09-27_stage1_recovery_identity_inspection.md`,
  `2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`.
- Untracked pre-existing test: `server/tests/restoreRoomWalletRefund.test.js`
  (not run in this stage; unrelated).

Pre-existing ESLint problems in
`client/src/context/RecoveryExperienceContext.jsx` (untouched lines; the two
`react-hooks/refs` errors sit on the pre-existing
`resetToWelcomeRef.current = ...` / `sessionGenerationRef.current = ...`
assignments, shifted only by the 8 added trace lines above them):

- 131:5 / 133:5 error `react-hooks/refs` — Cannot access refs during render.
- 410:8 warning `react-hooks/exhaustive-deps` — `clearIdentity`,
  `destroySession` (pre-existing callback deps; the new `setIdentity` dep is
  correctly listed and not flagged).
- 881:17 error `react-refresh/only-export-components` — pre-existing.

Nothing committed. Nothing pushed.
