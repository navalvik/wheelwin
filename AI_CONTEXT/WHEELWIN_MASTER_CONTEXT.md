# WheelWin Master Context

## 1. Project Identity

Project name:

WheelWin

WheelWin is a deterministic peer-versus-peer multiplayer game.

WheelWin is NOT a casino.

The game consists of exactly 3 players competing only against each other.

The server acts as an impartial referee.

The server never plays against players.

---

# 2. Core Game Philosophy

The game must always preserve fairness:

- No house edge.
- No RTP.
- No weighted probabilities.
- No hidden modifiers.
- No jackpot sectors.
- No bonus sectors.

Every purchased sector has exactly equal probability.

The result must come from deterministic server-controlled game physics.

---

# 3. Technology Stack

## Frontend

- React
- Vite

Main pages:

- Page1Welcome
- RoomLobby
- Page2PlayerSetup
- PageMatrix
- Page3VerifyPlayers
- Page4Payment
- Page5WheelGame
- Page6Result (planned)

---

## Backend

- Node.js
- Express
- Socket.IO

Architecture:

Event-driven server.

Main principle:

Server authoritative after:

GAME_INITIALIZED

---

## Blockchain

Platform:

TON

Financial components:

- GameEscrow
- Deposit flow
- PaymentSession
- Financial persistence

---

# 4. Architecture Model

WheelWin is separated into domains.

## Room Domain

Responsible for:

- Room lifecycle.
- Player slots.
- Room state.

Main module:

RoomManager

---

## Player Domain

Responsible for:

- Player identity.
- Wallet binding.
- Player profile.

Main module:

PlayerManager

---

## Configuration Domain

Responsible for:

- Immutable game configuration.
- Wheel configuration.
- Player sectors.
- Colors.
- Icons.

Main module:

ConfigurationEngine

---

## Payment Domain

Responsible for:

- Payment sessions.
- TON integration.
- Financial validation.

Main modules:

- PaymentEngine
- PaymentSessionManager
- GameContractManager

---

## Gameplay Domain

Responsible for:

- GameState.
- Physics.
- Input processing.
- Winner calculation.

Main modules:

- GameStateEngine
- PhysicsEngine
- InputAuthority
- WinnerEngine

---

## Recovery Domain

Responsible for:

- Restoring valid sessions.
- Reconstructing runtime objects.

Recovery must be fail-closed.

Never invent state.

---

# 5. Server Authority Rules

After GAME_INITIALIZED:

Server owns:

- Game lifecycle.
- Player state.
- Configuration.
- Physics.
- Winner.
- Recovery decisions.

Client:

- Displays server state.
- Sends commands.
- Renders UI.

Client never:

- Calculates winners.
- Creates authoritative configuration.
- Modifies payments.
- Overrides timers.

---

# 6. Development History Summary

Completed:

## C3.x Server Authoritative Gameplay Core

Implemented:

- Game bootstrap.
- SimulationLoop.
- Physics updates.
- Input Authority.
- Winner Engine.

---

## C4.x Validation

Completed:

- Gameplay validation.
- Replay validation.
- Long-run stability.
- Production validation.

Validated:

- Complete sessions.
- Reconnect.
- Offline players.
- Multiple sessions.

---

## C5.x Client Ownership Migration

Completed:

Moved authority from client to server.

Completed:

- Player data migration.
- Room metadata migration.
- Payment display migration.
- Server-owned setup timer.

---

## R5.x Configuration Stabilization

Completed:

- Server icon assignment.
- Server color assignment.
- Delayed configuration generation.
- Removal of client defaults.

---

# 7. Current Development State

Current milestone:

R17.9T.6

Area:

TON financial recovery architecture.

Current architectural decision:

Hybrid Recovery Architecture.

---

# 8. Current Problem

Financial state and gameplay state are different domains.

Financial data:

Durable.

Gameplay data:

Ephemeral.

Current gap:

Blockchain financial state can be restored.

Runtime gameplay objects cannot yet be reconstructed.

Missing capabilities:

- attachExistingRoom()
- attachExistingGame()
- PaymentSession rehydration
- Guarded contract reconciliation

---

# 9. Next Development Direction

Implementation order:

1. Identity attach.
2. PaymentSession rehydration.
3. GameContract reconciliation.
4. Configuration reconstruction.
5. Controlled end-to-end validation.

Do not create new payment paths.

Do not bypass validation.

---

# 10. Important Development Rules

AI agents working with WheelWin must:

- Preserve architecture.
- Make small changes.
- Understand ownership before coding.
- Validate before modifying.
- Commit completed stages.

Never:

- Rewrite architecture.
- Simplify domain separation.
- Move server logic to client.
- Create parallel systems.

---

# 11. Important Documentation

AI agents should read:

1. AI_CONTEXT/ARCHITECTURE_RULES.md
2. AI_CONTEXT/CURRENT_STATE.md
3. AI_CONTEXT/DEVELOPMENT_HISTORY.md
4. AI_CONTEXT/AI_WORKING_RULES.md

before making changes.

---

# Final Statement

WheelWin is a production-oriented multiplayer blockchain game architecture.

Existing complexity is intentional.

The priority order is:

1. Correctness.
2. Security.
3. Deterministic behaviour.
4. Maintainability.
5. Development speed.