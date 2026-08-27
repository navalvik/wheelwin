# R18 S4 — Client Authoritative Deposit Transport + Reconnect

Date: 2026-08-27

Task: Implement ONLY the client/server transport and authoritative-session
integration for the already-existing R18 Deposit package flow. No Page4 UI
redesign, no PaymentSession/GameContract flow replacement, no blockchain
transactions, no broadcast of private financial data.

---

## 1. Scope

- Client socket event: `DEPOSIT_PACKAGE_PUBLISHED`.
- `SocketSyncLayer` listener (existing raw socket pattern, single dispatcher).
- `EngineBridge` fan-out route to the authoritative-session module.
- `AuthoritativeSessionContext` handler.
- `authoritativeSessionModel` reducer action + `deposit` mirror field.
- Server reconnect restoration of the requester-scoped Deposit projection.
- Focused tests (client + server).

Explicitly NOT changed: Page4 UI, PaymentSession flow, GameContractManager,
DepositMonitor, DepositOnChainVerificationCoordinator, DepositSessionCoordinator,
DepositOrchestrator, .env files. No blockchain transaction was performed.

## 2. Files Inspected

- AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md, ARCHITECTURE_RULES.md, CURRENT_STATE.md,
  AI_WORKING_RULES.md.
- client/src/socket/socketEvents.js, SocketSyncLayer.js, EngineBridge.js,
  SocketDispatcher.js, socketSyncLayer.test.js.
- client/src/game/session/authoritativeSessionModel.js (+ test).
- client/src/context/AuthoritativeSessionContext.jsx.
- server/socket/RoomLobbyBridge.js, lobbyProtocol.js.
- server/socket/gameplayRecoveryProtocol.js, server/deposit/projectDepositForPlayer.js.
- server/tests/r18DepositProjection.test.js, setupSession.reconnect.test.js.

## 3. Architecture Findings

The existing server flow is `DEPOSIT_PACKAGE_PUBLISHED` → requester-scoped
`projectDepositForPlayer()` → per-socket delivery. The projection is
authoritative and must stay the source of truth. The client mirror is purely
informational.

## 4. Lifecycle Flow

```
Server RoomLobbyBridge.reconnectSession (authenticated player reclaim)
  └─ projectDepositForPlayer(playerId, roomId, gameId, coordinator, bridge)
      └─ deliver LOBBY_SERVER_EVENTS.DEPOSIT_PACKAGE_PUBLISHED { deposit } to socket

Client
  SocketSyncLayer._handleDepositPackagePublished
   └─ SocketDispatcher
       └─ EngineBridge[INCOMING_SOCKET_EVENTS.DEPOSIT_PACKAGE_PUBLISHED]
           └─ authoritativeSession.onDepositPackagePublished(payload)
               └─ store.dispatch(DEPOSIT_PACKAGE_PUBLISHED)
                   └─ reducer stores frozen requester-scoped deposit mirror
```

## 5. Ownership Boundaries

- Server owns Deposit financial authority, lifecycle, funding, and projection.
- `projectDepositForPlayer()` is the single authority for requester scoping and
  for whether the package is still exposed (lifecycle/terminal/funding rules).
- Client reducer is a frozen mirror only.

## 6. Risks

- Critical: none introduced.
- High: none (no projection fabrication, no local amount/seat/creator derivation).
- Medium: none. The client mirror could become stale if a live `DEPOSIT_PACKAGE_PUBLISHED`
  is missed; reconnect re-delivery mitigates this.
- Low: full client test suite contains a pre-existing failure in
  `game/playerUI/playerUI.productionIdentity.test.js` (imports only PlayerUIEngine,
  PlayerState, WinnerResolver — none of which were touched by this task).

## 7. Recommendations

- Keep the reconnect restoration on the reconnectSession path; do not build a
  second funding-reconciliation layer.
- Future Page4 work should consume the mirrored `deposit` field only for display.

## 8. Changes Made

Files changed:
- client/src/socket/socketEvents.js — added INCOMING_SOCKET_EVENTS.DEPOSIT_PACKAGE_PUBLISHED.
- client/src/socket/SocketSyncLayer.js — bind/off + handler for the event.
- client/src/socket/EngineBridge.js — route to session().onDepositPackagePublished.
- client/src/context/AuthoritativeSessionContext.jsx — onDepositPackagePublished.
- client/src/game/session/authoritativeSessionModel.js — action, `deposit: null`
  initial field, frozen mirror reducer (fail-closed on invalid payload).
- server/socket/RoomLobbyBridge.js — reconnect restoration of the requester-scoped
  projection via projectDepositForPlayer, per-socket delivery.
- Tests: client/src/socket/socketSyncLayer.test.js,
  client/src/game/session/authoritativeSessionModel.test.js,
  server/tests/r18S4DepositReconnect.test.js (new).

Scope discipline honoured: no financial module, no Page4, no .env change.