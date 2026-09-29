# Stage 1 — Client Recovery Identity Flow Inspection (recoveryCredential)

Date: 2026-09-27

Task: Inspection-only analysis of the existing client recovery identity flow for the
real Testnet incident room **hKdb**, whose server log signature was
`SESSION_RECOVERY_REQUEST` → `credentialPresent=false` → `RECOVERY_AUTH_MISSING`.
Identify exactly where the client stores, restores, clears, and sends the recovery
credential, and why the incident produced an identity with `roomId`+`playerId`
present but `recoveryCredential` missing. No source files, tests, payment code,
VERIFY logic, GameStartAuthorization, Room Wallet logic, or server files were
modified. Server files were read only to understand the protocol.

---

## 1. Scope

- Client-side recovery identity: storage, restore, clear, issuance ingestion,
  `SESSION_RECOVERY_REQUEST` construction and emit triggers.
- Handling of recovery success (`SETUP_SESSION_SYNC`, `SESSION_SNAPSHOT`) and
  failure (`SESSION_RECOVERY_FAILED`, `RECOVERY_AUTH_MISSING`).
- Server protocol (read-only): credential issuance points, credential validation,
  denial payload path.
- Explicitly out of scope / untouched: GameEscrow / DepositContract /
  DepositPackage references (treated as legacy residue per the active
  Room Wallet Testnet architecture), PaymentSession internals, refund logic,
  smart contracts, VERIFY logic, GameStartAuthorization, Room Wallet logic.

---

## 2. Files Inspected

Context (required reading, per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_setup_session_restart_rearm_analysis.md`

Client (primary inspection targets):

- `client/src/context/PlayerIdentityContext.jsx` — full (storage owner).
- `client/src/context/RecoveryExperienceContext.jsx` — lines 93–870
  (`requestSessionRecovery`, boot restore, reconnect, wake-up, failure handling).
- `client/src/pages/RoomLobby.jsx` — full (identity ingestion from lobby events).
- `client/src/pages/Page3VerifyPlayers.jsx` — full (identity consumer; does not
  touch the credential).
- `client/src/pages/Page5Game.jsx` — lines 100–210 (hydration recovery trigger).
- `client/src/components/CreateRoomPanel.jsx` — lines 60–110 (duplicate
  `roomCreated` identity ingestion).
- `client/src/context/AuthoritativeSessionContext.jsx` — lines 55–175
  (`startGame` identity sync — no credential).
- `client/src/game/sessionRecovery/recoveryFlow.js` — full
  (`hasGameplayIdentity`, `isTerminalRecoveryFailure`).
- `client/src/game/sessionRecovery/sessionRecoveryEvents.js` — event constants.
- `client/src/game/sessionRecovery/SessionRecoveryEngine.js` — lines 100–250
  (legacy secondary emitter; `reconnect()` no longer emits).
- `client/src/context/SessionRecoveryContext.jsx` — lines 40–150 (engine wiring).
- `client/src/App.jsx` — lines 39–43 + provider mount 333–387 (start page is 1;
  `PlayerIdentityProvider key={sessionGeneration}`).

Server (protocol understanding only — NOT modified):

- `server/socket/SocketGateway.js` — `_handleRecoveryRequest` (1226–1420),
  `_sendRecoveryFailed` (1628–1654).
- `server/socket/RoomLobbyBridge.js` — `_handleCreateRoom` credential issuance
  (1331–1361), `_handleJoinRoom` issuance (2258–2280),
  `issueRecoveryCredential` (2677–2681), `authorizeRecoveryCredential`
  (2686–2698), `reconnectSession` (2707–2800), `reconnectGameplaySession`
  (3203–3205), `_denyRecoveryIdentity` (8256+).
- `server/gameplay/RecoveryCredentialStore.js` — full
  (`RECOVERY_AUTH_REASONS.MISSING` definition, validate semantics).

Search-only context: prior report
`AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_protected_reconnect_deposit_rehydration_fix.md`
(documents the same production signature: "Lena's recoveries had
`credentialPresent=false`, and `reconnectSession()` would deny a playerId claim
without a credential").

Note: the room code "hKdb" does not appear anywhere in this workspace; the
failure chain below is reconstructed from code plus the documented
`credentialPresent=false` precedent.

---

## 3. Architecture Findings

### 3.1 Where recoveryCredential is stored (Answer to Q1)

The single storage owner is:

- `client/src/context/PlayerIdentityContext.jsx`

It owns one JSON blob `{ roomId, playerId, gameId, recoveryCredential }` exposed
through `PlayerIdentityContext` (`identity`, `setIdentity`, `clearIdentity`,
`getIdentity`).

Credential ingestion call sites (all merge into the same blob):

- `client/src/pages/RoomLobby.jsx` — `roomCreated` (lines 37–43) and
  `roomJoined` (53–59): `...(data.recoveryCredential ? { recoveryCredential } : {})`.
- `client/src/components/CreateRoomPanel.jsx` — its own `roomCreated` listener
  (81–87), same conditional spread.
- `client/src/pages/RoomLobby.jsx` — `startGame` (81–85): merges
  `roomId`/`gameId`/`playerId` **without** credential (preserves any existing one).
- `client/src/context/AuthoritativeSessionContext.jsx` — `onGameStart` (112–116):
  merges `roomId`/`gameId`/`playerId` **without** credential (same intent).

### 3.2 Storage mechanism (Answer to Q2)

- **`window.sessionStorage`** — key `wheelwin.setupRecoveryIdentity`
  (`PlayerIdentityContext.jsx` line 21), JSON-serialized by
  `writeStoredIdentity` (73–109), called on every `setIdentity` merge.
- A second sessionStorage key `wheelwin.setupRecoveryPage` (line 23) stores the
  last setup/gameplay page index (`writeStoredRecoveryPage`, wired in
  `RecoveryExperienceContext` lines 484–493).
- Not memory-only, not localStorage. sessionStorage lifetime = tab/WebView
  instance. Two deliberate behaviors matter:
  - Storage failures (quota/private mode) are silently swallowed
    (lines 103–107) — identity continues in memory for the current page
    lifetime only.
  - `writeStoredIdentity(EMPTY_IDENTITY)` → `removeItem` of both keys (85–87).

### 3.3 Restore path after a new page/WebView instance (Answer to Q3)

1. `App.jsx` always starts at `currentPage = 1` (WELCOME) and mounts
   `PlayerIdentityProvider key={sessionGeneration}` (line 335).
2. Provider init: `useState(() => readStoredIdentity())`
   (`PlayerIdentityContext.jsx` line 165) → `readStoredIdentity()` (32–71)
   parses `wheelwin.setupRecoveryIdentity`; returns
   `recoveryCredential: parsed.recoveryCredential ?? null`. If `roomId` or
   `playerId` is missing → `EMPTY_IDENTITY` (all-null).
3. `RecoveryExperienceContext` "Scenario C" boot effect (495–551): when
   `currentPage === WELCOME`, identity has roomId+playerId, and
   `readStoredRecoveryPage()` returns a setup-recovery page (LOBBY..PAYMENT),
   `tryBootRecovery()` → `requestSessionRecovery()`.
4. Success handling:
   - Setup: server `SETUP_SESSION_SYNC` → `onSetupSessionSync` →
     `handleSetupRecoveryComplete` (198–228) → navigate to the stored page →
     overlay COMPLETE.
   - Gameplay: `SESSION_SNAPSHOT` → `handleGameplaySnapshot` (230–409) → apply
     snapshot → navigate Page5/Page6 → COMPLETE.
5. Legacy `SessionRecoveryEngine` (`SessionRecoveryContext.jsx`) only restores
   modules from the pending snapshot; its `reconnect()` intentionally no longer
   emits (comment at `SessionRecoveryEngine.js` lines 177–179). Its
   `requestRecovery()` (187–220) remains a secondary emitter with the same
   identity-derived payload.

### 3.4 Clear path (Answer to Q4)

- `clearIdentity()` (`PlayerIdentityContext.jsx` 190–198) resets state and
  removes both sessionStorage keys.
- Called from exactly two places, both in `RecoveryExperienceContext.jsx`:
  - `handleRecoveryFailed` (line 443) — only when
    `isTerminalRecoveryFailure(payload)` is true.
  - `returnToLobby` (line 462) — API kept for stability; overlays no longer
    expose it (R7.70C20).
- Implicit clears: `writeStoredIdentity` removes storage when roomId/playerId
  are absent; sessionStorage also dies with the tab/WebView instance.
- `RECOVERY_AUTH_MISSING` does NOT clear the identity (see 3.6).

### 3.5 SESSION_RECOVERY_REQUEST construction (Answer to Q5)

- Builder/emit point: `requestSessionRecovery()`
  (`RecoveryExperienceContext.jsx` lines 165–196), emitted on the shared
  `SOCKET_MESSAGE_CHANNEL`:
  `{ type: "SESSION_RECOVERY_REQUEST", payload: { timestamp, playerId, roomId, recoveryCredential: identity.recoveryCredential ?? null } }`.
- Gate: `hasGameplayIdentity(identity)` — roomId && playerId only
  (`recoveryFlow.js` lines 128–132). **The credential is NOT required to send
  the request**, and `recoveryInFlightRef` prevents re-entry.
- Emit triggers: boot restore (533), reconnect after disconnect (738, R17.8F
  Case B), WebView wake-up `visibilitychange`/`pageshow` (592, R12.2), Page5
  config-hydration grace expiry (`Page5Game.jsx` 187).
- Client trace `recoveryTrace("SESSION_RECOVERY_REQUEST sent", …)` (191–194)
  logs only roomId/playerId/socket.id — **credentialPresent is not logged
  client-side**.

### 3.6 Server protocol (read-only) and the failure chain (Answer to Q6)

Issuance (the ONLY two plaintext deliveries in the system):

- `RoomLobbyBridge._handleCreateRoom` → `issueRecoveryCredential(playerId, roomId)`
  (1331–1334) → `ROOM_CREATED` payload includes `recoveryCredential` (1348–1361).
- `RoomLobbyBridge._handleJoinRoom` → same (2258–2261) → `ROOM_JOINED` payload
  (2269–2280).
- `RecoveryCredentialStore.issue()` stores only a SHA-256 hash
  (`RecoveryCredentialStore.js` 36–54). **The plaintext is never persisted
  server-side, reclaim never re-issues, and no later server payload carries a
  credential.**

Request handling:

- `SocketGateway._handleRecoveryRequest` (1226–1420): resolves the gameplay
  context for the socket. A new WebView has a NEW `socket.id` → context NOT
  bound → unbound path → `RoomLobbyBridge.reconnectGameplaySession` (aliased to
  `reconnectSession`, 3203–3205).
- `reconnectSession` (2707+): for any `claim.playerId` it calls
  `authorizeRecoveryCredential` → `RecoveryCredentialStore.validate`
  (2686–2698 → 61–138). Missing/empty credential ⇒
  `{ ok: false, reason: RECOVERY_AUTH_REASONS.MISSING }` — the literal string
  **`RECOVERY_AUTH_MISSING`** (`RecoveryCredentialStore.js` line 11).
- Denial → `_denyRecoveryIdentity("Recovery identity is not authorized for this
  socket", { authReason })` (2749–2775) → `SESSION_RECOVERY_FAILED` to the
  client via `SocketGateway._sendRecoveryFailed` (1628–1654). Server logs carry
  `credentialPresent=false` (1237–1251, 2719–2747).
- R18-S16 nuance: the denial applies to the UNBOUND (new socket id) path. A
  same-socket-id protected reconnect skips full reclaim and stays bound —
  the previous mitigation for the same signature.

Exact failure point for hKdb:

1. The client identity had `roomId`+`playerId` but `recoveryCredential: null`.
   The code base produces that state through a concrete, documented race: the
   identity is first created WITHOUT a credential by the `startGame` handlers
   (`RoomLobby.jsx` 81–85 — comment: "startGame can arrive before roomJoined,
   after JoinRoomPanel has unmounted"; `AuthoritativeSessionContext.jsx`
   112–116). The credential normally arrives later via `roomJoined`. If
   `roomCreated`/`roomJoined` is never received or never stored (socket drop
   in that window, panel unmount timing, sessionStorage write failure, or a
   build/deploy without R13.1E payload fields), the identity is permanently
   credential-less: **nothing in the client ever re-acquires the credential
   afterward** (no other payload carries it; server never re-sends it).
2. Page/WebView recreation: `readStoredIdentity()` faithfully restores the same
   all-but-credential identity (`recoveryCredential ?? null`).
3. `requestSessionRecovery()` does not require the credential → emits
   `recoveryCredential: null` → server logs `credentialPresent=false`.
4. New socket id → unbound path → `RECOVERY_AUTH_MISSING` → denial.
5. Client handling: `isTerminalRecoveryFailure("Recovery identity is not
   authorized for this socket")` matches NO terminal code/pattern
   (`recoveryFlow.js` 138–151) → NOT terminal → identity kept, overlay hides →
   the next connect repeats the identical doomed request. The seat stays
   stashed server-side while that client instance can never reclaim it.

Related (different signature) exposure: if Telegram kills the WebView
entirely, sessionStorage dies with it → identity AND stored page are empty →
boot recovery no-ops at WELCOME → no reclaim is attempted at all. Same seat
loss, different logs. Both mechanisms are consistent with a live
`credentialPresent=false` incident trace.

---

## 4. Lifecycle Flow

```text
CREATE / JOIN (seat birth)
  server: issueRecoveryCredential()  ← ONLY plaintext delivery (create+join)
  client: roomCreated/roomJoined → setIdentity({roomId, playerId, recoveryCredential})
          → sessionStorage("wheelwin.setupRecoveryIdentity")
  race:   startGame may arrive first → identity exists WITHOUT credential

RELOAD / WEBVIEW RECREATION
  App boots on WELCOME
  PlayerIdentityProvider init → readStoredIdentity() (sessionStorage)
  storedPage = readStoredRecoveryPage()
  boot effect → requestSessionRecovery()

REQUEST
  requestSessionRecovery()
    gate: roomId && playerId  (credential NOT required)
    emit SESSION_RECOVERY_REQUEST {timestamp, playerId, roomId, recoveryCredential ?? null}

SERVER (new socket id = unbound)
  authorizeRecoveryCredential → validate
    credential null/empty → RECOVERY_AUTH_MISSING
  → _denyRecoveryIdentity → SESSION_RECOVERY_FAILED
       "Recovery identity is not authorized for this socket"

CLIENT
  handleRecoveryFailed → isTerminalRecoveryFailure = false
  → overlay hides, identity kept → next connect repeats the same denial
  (no rotation, no re-issue, no re-delivery exists anywhere)
```

---

## 5. Ownership Boundaries

- Recovery identity state owner (client): `PlayerIdentityContext` (single
  storage owner; all writers merge through `setIdentity`).
- Recovery flow owner (client): `RecoveryExperienceContext` (request building,
  triggers, overlay, terminal wipe decisions).
- Credential issuance/validation owner (server): `RecoveryCredentialStore` via
  `RoomLobbyBridge`; routing in `SocketGateway._handleRecoveryRequest`.
- Legacy/adjacent: `SessionRecoveryEngine` (module restore only; `reconnect()`
  deliberately no longer emits; `requestRecovery()` dormant secondary path).
- The client remains a projection of server state; the credential is a
  server-issued ownership proof (R13.1E). Nothing in this flow grants the
  client authority over gameplay or payment state.

---

## 6. Risks

- **High — credential is unacquireable after the create/join race:**
  identity can exist with `recoveryCredential: null` and there is no client or
  server path that ever repairs it. Every future unbound reclaim for that
  client fails with `RECOVERY_AUTH_MISSING` while the seat remains stashed.
  This is the hKdb failure point.
- **High — sessionStorage is WebView-lifetime only (design gap for Telegram):**
  a WebView kill wipes both identity and stored page → boot recovery no-ops at
  WELCOME → the client cannot even attempt a reclaim (silent seat loss).
- **Medium — no client-side `credentialPresent` trace:** the
  `SESSION_RECOVERY_REQUEST sent` trace omits credential presence, making
  browser-side diagnosis of this exact signature impossible without server
  logs.
- **Medium — silent sessionStorage write failures** (`PlayerIdentityContext`
  catch blocks) can leave a memory-only identity that loses the credential on
  the very next reload, indistinguishable from the race above.
- **Low — non-terminal failure loop:** `RECOVERY_AUTH_MISSING` denials repeat
  on every reconnect (log noise; no user-visible terminal state).
- **Low — legacy residue:** GameEscrow/DepositContract/DepositPackage
  references encountered in older reports were treated as legacy residue per
  the active Room Wallet architecture and were not analyzed or modified.

---

## 7. Recommendations (minimal Stage 2 only — no redesign, approval required)

Recommended minimal change (one small, additive client-side change plus one
diagnostic):

1. **Diagnostic (recommended first):** extend `recoveryTrace("SESSION_RECOVERY_REQUEST
   sent", …)` in `RecoveryExperienceContext.requestSessionRecovery()` (lines
   191–194) to include `credentialPresent=Boolean(identity.recoveryCredential)`.
   Additive log only; makes the hKdb signature diagnosable from the browser
   console. `server/socket/SocketGateway.js` already logs `credentialPresent`.

2. **Credential repair on the already-authorized private path:** the server
   cannot re-deliver a lost plaintext (only hashes are stored), but it CAN
   re-issue. Smallest safe repair: on a socket that is already
   authoritatively bound to the player (protected same-id reconnect /
   requester-scoped `SETUP_SESSION_SYNC` delivery), have
   `RoomLobbyBridge._deliverSetupSessionSync` include a freshly
   `issue()`d `recoveryCredential`, and have the client's
   `onSetupSessionSync` handler (`RecoveryExperienceContext` lines 784–797)
   persist it via `setIdentity({ recoveryCredential: payload.recoveryCredential })`.
   This heals the "credential null forever" state on the next authorized sync
   without weakening the unbound claim path (unbound requests still fail
   closed). Server-side touch is confined to one existing private delivery
   point.

3. **Do NOT** in Stage 2: relax `reconnectSession` credential requirements,
   move identity to localStorage, add new recovery events, or touch
   PaymentSession/VERIFY/GameStartAuthorization/Room Wallet logic.

4. **Follow-up (separate stage):** Telegram WebView-killed-session gap
   (sessionStorage loss) needs its own architecture review — likely server-side
   seat-stash recovery UX, not a storage-mechanism swap. Out of Stage 2 scope.

---

## 8. Changes Made

- Created this report only:
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1_recovery_identity_inspection.md`.
- **No source files modified. No server files modified. No payment, VERIFY,
  GameStartAuthorization, Room Wallet, or TON logic touched. No tests
  modified. Nothing committed or pushed.**
- Pre-existing working-tree state (not from this stage) was observed via a
  read-only `git status` at HEAD `53fe3ba8c7f45d5d13ebfcc434f89e7de2493be3`:
  modified `server/gameplay/PaymentSessionManager.js` and untracked prior
  reports/tests (`2026-09-27_gameescrow_depositcontract_remaining_links_analysis.md`,
  `2026-09-27_payment_session_restore_room_wallet_refund_gap.md`,
  `2026-09-27_setup_session_restart_rearm_analysis.md`,
  `2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`,
  `server/tests/restoreRoomWalletRefund.test.js`). These were left untouched.




