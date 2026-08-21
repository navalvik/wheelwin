# Initial Project Structure Audit

Date: 2026-08-21

Task: Read `.clinerules`; perform a read-only project structure audit covering project structure, main frontend modules, main backend modules, existing `AI_CONTEXT` documentation, and current architecture boundaries. No source code changes were allowed.

## 1. Scope

This audit inspected the WheelWin repository structure and documented the current architectural organization without modifying source code.

Analyzed areas:

- Root project layout and package metadata.
- Frontend React/Vite application structure under `client/`.
- Backend Node.js/Express/Socket.IO application structure under `server/`.
- TON smart-contract package under `contracts/`.
- Existing architecture and working-rule documentation under `AI_CONTEXT/`.
- Current architecture boundaries between client, server, gameplay, room, player, configuration, payment, recovery, audit, socket, input, simulation, and blockchain-related domains.

This was not a behavioral test pass and did not execute application test suites. The audit was structural and architectural only.

## 2. Files Inspected

Instruction and source-of-truth documentation:

- `.clinerules`
- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`
- `AI_CONTEXT/DEVELOPMENT_HISTORY.md` was listed as part of existing context documentation, but the mandatory read set for this task was the four files defined in `.clinerules` plus `.clinerules` itself.

Package and project metadata:

- `_package.json`
- `client/package.json`
- `server/package.json`
- `contracts/package.json`

Frontend structure and key files:

- `client/src/`
- `client/src/main.jsx`
- `client/src/App.jsx`
- `client/src/providers/GameEngineProviders.jsx`
- `client/src/pages/`
- `client/src/game/`
- `client/src/socket/`
- `client/src/payment/`
- `client/src/socket/SocketSyncLayer.js`
- `client/src/game/gameAuthority.js`

Backend structure and key files:

- `server/`
- `server/app.js`
- `server/index.js`
- `server/events/EventBus.js`
- `server/managers/`
- `server/engines/`
- `server/gameplay/`
- `server/socket/`
- `server/input/`
- `server/simulation/`
- `server/payment/`
- `server/recovery/`

Documentation directories listed:

- `AI_CONTEXT/CLINE_REPORTS/`
- `AI_CONTEXT/Cursor_Migration/`
- `docs/architecture/`

## 3. Architecture Findings

### Project identity

WheelWin is documented as a deterministic peer-versus-peer multiplayer game with exactly 3 players competing against each other. The documentation repeatedly states that WheelWin is not a casino and must not introduce RTP, house edge, weighted probabilities, jackpot mechanics, bonus sectors, hidden modifiers, or artificial player disadvantage.

### Repository structure

The project is organized into distinct top-level areas:

- `client/` — React/Vite frontend.
- `server/` — Node.js backend using Express and Socket.IO.
- `contracts/` — TON/Tact/Blueprint smart-contract package.
- `AI_CONTEXT/` — project source-of-truth documentation for AI agents.
- `docs/` — historical architecture, audit, validation, and operations reports.
- `config/` — owner configuration example.
- `scripts/` — project-level scripts.

The root `_package.json` is CommonJS and appears to represent legacy/root metadata. Active application packages appear to be `client/package.json`, `server/package.json`, and `contracts/package.json`.

### Frontend structure

The frontend is a React/Vite application using:

- React 19.
- Vite.
- React Router.
- Socket.IO client.
- TON Connect UI.

Main frontend pages currently present under `client/src/pages/`:

- `Page1Welcome.jsx`
- `RoomLobby.jsx`
- `Page2PlayerSetup.jsx`
- `Page2Room.jsx`
- `PageMatrix.jsx`
- `Page3Verify.jsx`
- `Page3VerifyPlayers.jsx`
- `Page4Payment.jsx`
- `Page5Game.jsx`
- `Page6Result.jsx`
- `PageDeveloperConsole.jsx`
- `PageDeveloperDashboard.jsx`

`client/src/App.jsx` owns the local page-flow rendering shell. It routes the normal game flow through `GameFlow` and conditionally exposes `/debug` for the developer console. The game flow renders pages by numeric stage and delegates authoritative session/gameplay state to providers and socket-driven systems.

Important frontend module groups:

- `client/src/context/` — React context ownership for projected state.
- `client/src/providers/GameEngineProviders.jsx` — single gameplay provider stack.
- `client/src/socket/` — socket transport, dispatch, sync layer, engine bridge.
- `client/src/game/session/` — authoritative session projection and terminal navigation helpers.
- `client/src/game/sessionRecovery/` — client recovery flow and route handling.
- `client/src/game/physics/` — client-side rendering/projection helpers for physics state.
- `client/src/game/winner/` — result presentation utilities; not authoritative winner ownership.
- `client/src/payment/` — TON Connect transaction construction.

`client/src/game/gameAuthority.js` explicitly documents that socket disconnect must never hand gameplay ownership to the client. It derives `isServerAuthoritative()` from the authoritative session lifecycle rather than raw transport state.

`client/src/providers/GameEngineProviders.jsx` preserves one gameplay provider stack and notes that `gameId`/`roomId` are not provider props; they live on `AuthoritativeSession` and are filled by the server over socket messages.

### Backend structure

The backend is the architectural authority. `server/package.json` defines a module-based Node.js package with `app.js` as the main runtime entrypoint.

`server/app.js` is the main composition root. It imports and wires managers, engines, gameplay lifecycle components, payment/recovery systems, diagnostics, persistence, socket gateway, and operational services.

`server/index.js` is a small CommonJS Express stub returning `WheelWin API Running`. Given `server/package.json` uses `"type": "module"` and starts `app.js`, `index.js` appears legacy or non-primary and should not be treated as the authoritative runtime entrypoint without further investigation.

Main backend module groups identified:

- `server/managers/`
  - `RoomManager` — room lifecycle, room capacity, room player membership.
  - `PlayerManager` — player identity, runtime state, connection/player state.
  - `GameManager` — game creation, initialization, start/finish/destroy, gameplay bootstrap coordination.

- `server/engines/`
  - `ConfigurationEngine` — immutable game configuration generation/validation/freeze/commit.
  - `GameStateEngine` — game state lifecycle and transitions.
  - `GameClockEngine` — authoritative phase timing and clock state.
  - `PhysicsEngine` — authoritative wheel/triangle simulation state and deterministic updates.
  - `WinnerEngine` — server-side winning sector/player/result resolution.
  - `PaymentEngine` — payment preparation/processing records.
  - `RecoveryEngine` — gameplay recovery snapshots.
  - `AuditEngine` and `GameReportEngine` — audit/report generation.

- `server/gameplay/`
  - Phase and lifecycle orchestration including `GameplayLifecycle`, `GameplayPhaseLifecycle`, `SetupSessionLifecycle`, `ResultSessionLifecycle`, `PaymentSessionManager`, `GameContractManager`, `GameStartAuthorization`, `PreGameReadyActivation`, `SpeedActivation`, `WinnerActivation`, `ResultActivation`, `PaymentActivation`, `AuditActivation`, and `RecoverySnapshotCache`.

- `server/input/`
  - `InputAuthority` — authoritative player input validation, input state, command queue, accepted/rejected input emission.

- `server/simulation/`
  - `SimulationLoop` — fixed-step loop coordinating authoritative physics and input processing.

- `server/socket/`
  - `SocketGateway` — Socket.IO gateway and server-to-client gameplay sync.
  - `RoomLobbyBridge` — lobby socket handling, room join/leave, profile setup, payment-stage delivery, recovery identity, and client delivery bridging.
  - Protocol builders for game state, clock, physics, input, payment, audit, wheel configuration, winner, and recovery messages.

- `server/payment/`
  - Blockchain monitoring, GameEscrow adapters, settlement manager/session state, TON contract adapter, reimbursement services, and payment utility modules.

- `server/recovery/`
  - `TonFinancialRecovery` and financial recovery errors. This reflects the current project focus on TON financial recovery architecture.

- `server/persistence/`, `server/deposit/`, `server/session/`, `server/diagnostics/`, `server/monitoring/`, `server/operations/`, `server/governance/`, `server/forensic/`, and related folders provide durable financial storage, deposit orchestration, diagnostics, runtime/production observability, and operational lifecycle support.

### Event-driven architecture

`server/events/EventBus.js` implements an event bus over an `EventDispatcher`, creates immutable event envelopes, carries trace IDs, and dispatches events to subscribers. This matches the documented event-driven architecture.

### Existing AI_CONTEXT documentation

`AI_CONTEXT/` contains:

- `WHEELWIN_MASTER_CONTEXT.md` — project identity, core philosophy, stack, domains, current state, current problem, and next direction.
- `ARCHITECTURE_RULES.md` — non-negotiable server authority, client restrictions, fairness rules, domain boundaries, TON/financial rules, workflow, testing rules.
- `CURRENT_STATE.md` — current phase: post-Cursor migration preparation / Cline onboarding; server authority completed; current focus is TON financial integration and recovery architecture.
- `AI_WORKING_RULES.md` — AI operating rules: preserve architecture, find responsible domain, avoid parallel systems, small staged work.
- `DEVELOPMENT_HISTORY.md` — listed as project history documentation.
- `CLINE_REPORTS/` — report output directory; it was empty before this report was created.
- `Cursor_Migration/` — migration context directories.

## 4. Lifecycle Flow

The documented and observed lifecycle is server-authoritative after `GAME_INITIALIZED`.

High-level flow inferred from documentation and module responsibilities:

1. Client starts through `client/src/main.jsx`, initializes React, `BrowserRouter`, TON Connect UI provider, and connects the Socket.IO client.
2. `client/src/App.jsx` renders the local page shell and `GameEngineProviders` stack.
3. Lobby and setup actions are sent from the client to the server through socket events.
4. `SocketGateway` and `RoomLobbyBridge` receive and bridge client socket messages into server-side room/player/payment/gameplay workflows.
5. `RoomManager` owns room creation, room lifecycle, player slots, and room state.
6. `PlayerManager` owns player identity and runtime player state.
7. `SetupSessionLifecycle` controls setup/session timing and setup completion.
8. `GameManager` coordinates game creation/bootstrap and invokes server-owned configuration generation after setup readiness.
9. `ConfigurationEngine` generates, validates, freezes, and commits immutable game configuration.
10. Payment-stage systems coordinate wallet connection, payment session creation, GameEscrow contract lifecycle, blockchain observation, and payment completion.
11. `GameStartAuthorization` gates game start on required authoritative conditions.
12. After `GAME_INITIALIZED`, the server owns gameplay state, configuration, timers, physics, input processing, winner determination, financial state, and recovery decisions.
13. `GameClockEngine`, `GameplayPhaseLifecycle`, phase controllers, `InputAuthority`, `SimulationLoop`, and `PhysicsEngine` drive authoritative gameplay progression.
14. `WinnerEngine` and `WinnerActivation` resolve the outcome from authoritative configuration and physics state.
15. `PaymentActivation`, `ContractSettlementManager`, audit systems, and result lifecycle components handle post-winner financial and result flow.
16. `SocketGateway` projects authoritative updates back to clients as game state, physics, clock, input ack, winner, payment, audit, and recovery messages.
17. The client renders server state through context providers and page components. It does not own authoritative gameplay truth.
18. Recovery systems are split by domain:
    - Gameplay recovery snapshots are runtime/server-derived.
    - TON financial recovery is durable, blockchain-aware, and fail-closed.

## 5. Ownership Boundaries

### Server-owned authority after `GAME_INITIALIZED`

The server owns:

- Game lifecycle.
- Room lifecycle.
- Player authoritative state.
- Immutable game configuration.
- Game clock and phase timing.
- Physics simulation.
- Input validation and command processing.
- Winner determination.
- Payment and financial state.
- Recovery decisions.
- Audit/report generation.

### Client-owned presentation and commands

The client owns:

- UI rendering.
- Page presentation.
- Sending player commands/intents.
- Displaying server-projected room, payment, gameplay, recovery, and result state.
- TON Connect UI interaction and transaction construction for user wallet interaction.

The client must not own:

- Authoritative winners.
- Authoritative random values.
- Authoritative game configuration.
- Payment truth.
- Server timers.
- Independent gameplay state after `GAME_INITIALIZED`.

### Domain boundaries

- Room domain is owned by `RoomManager` and lobby bridge integration.
- Player domain is owned by `PlayerManager`.
- Configuration domain is owned by `ConfigurationEngine`.
- Gameplay state domain is owned by `GameStateEngine` plus lifecycle components.
- Clock/phase domain is owned by `GameClockEngine` and gameplay phase controllers.
- Physics domain is owned by `PhysicsEngine` and `SimulationLoop`.
- Input domain is owned by `InputAuthority`.
- Winner domain is owned by `WinnerEngine` and winner activation flow.
- Payment session domain is owned by `PaymentSessionManager`.
- GameEscrow contract lifecycle is owned by `GameContractManager` and TON payment adapters.
- Settlement domain is owned by `ContractSettlementManager`.
- Financial recovery is owned by `TonFinancialRecovery` and durable persistence/blockchain monitors.
- Gameplay recovery snapshots are owned by `RecoveryEngine` and `RecoverySnapshotCache`.
- Socket projection is owned by `SocketGateway` and protocol builders.
- Client projection is owned by React context providers and `SocketSyncLayer`/`EngineBridge`.

## 6. Risks

### Critical

- Financial recovery remains an explicitly documented active gap: durable blockchain state can be restored, but runtime gameplay object reconstruction is still identified as incomplete in `WHEELWIN_MASTER_CONTEXT.md`.
- Any future change that treats client payment state, local UI state, or `READY`-style client state as financial truth would violate financial safety rules.
- Any future movement of winner calculation, physics authority, configuration ownership, or timer authority into the client would violate the core architecture.

### High

- `server/app.js` is a very large composition root. This centralizes wiring but increases risk when making changes because many domains are initialized and connected from one file.
- Payment, contract deployment, deposit, reimbursement, settlement, and recovery systems are strongly interconnected. Future modifications require careful ownership analysis before implementation.
- `server/index.js` appears to be a small legacy/non-primary CommonJS stub while `server/package.json` is ESM and starts `app.js`. Misidentifying the runtime entrypoint could cause incorrect maintenance work.

### Medium

- The frontend contains modules named `physics`, `winner`, and `GameState`; these appear to be projection/presentation utilities, but future contributors could misunderstand them as authority-owning modules unless documentation remains explicit.
- Client package dependencies include some backend-style packages such as `express`, `pg`, and `socket.io`. This may be historical or unused, but it can obscure frontend/backend dependency boundaries.
- Root `_package.json` duplicates some backend dependencies and may confuse tooling or onboarding because the active packages are nested.

### Low

- `AI_CONTEXT/CLINE_REPORTS/` was empty before this initial report, so there was no prior Cline report trail in that directory.
- Multiple historical docs under `docs/` and migration folders provide valuable context but increase onboarding surface area.

## 7. Recommendations

- Preserve the documented server-authoritative model exactly as-is.
- Treat `server/app.js` as the current backend composition root and inspect it before any backend lifecycle changes.
- Treat `client/src/App.jsx` and `client/src/providers/GameEngineProviders.jsx` as presentation/provider orchestration only; do not place authoritative gameplay decisions there.
- Before payment, escrow, settlement, deposit, reimbursement, or recovery changes, first identify the responsible server module and authoritative source of truth.
- Do not create parallel recovery, payment, configuration, input, physics, or winner systems.
- Consider a future documentation-only clarification distinguishing `server/app.js` from the likely legacy `server/index.js` to avoid runtime-entrypoint confusion.
- Consider a future dependency audit for root/client package metadata to determine whether backend-style client dependencies are intentional.
- Continue the preferred WheelWin workflow: analyze, report, architecture review, approval, implementation, validation, Git checkpoint.

## 8. Changes Made

Created this report only:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-21_initial_project_audit.md`

No source code files modified.