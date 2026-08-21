# WheelWin Current State

## Current Phase

Project: WheelWin

Current stage:
Post-Cursor migration preparation / Cline onboarding.

The project has completed:
- Server Authoritative Game Core.
- Gameplay lifecycle implementation.
- Client ownership migration.
- Major recovery architecture preparation.

---

# Current Architecture Status

## Server Authority

Completed.

Server is authoritative after:

GAME_INITIALIZED

Server owns:

- Game lifecycle.
- Player state.
- Game configuration.
- Physics.
- Winner calculation.
- Recovery decisions.

Client displays authoritative server state.

---

# Completed Development Stages

## C3.x — Server Authoritative Gameplay Core

Completed:

- Server bootstrap.
- Event-driven architecture.
- Simulation Loop.
- Physics Engine integration.
- Input Authority.
- Winner Engine.
- Gameplay lifecycle cleanup.

---

## C4.x — Validation Phase

Completed:

- Gameplay completion validation.
- Replay validation.
- Long run stability validation.
- Production validation suite.

Validated scenarios:

- Complete games.
- Reconnect.
- Offline players.
- Multiple sessions.
- Resource cleanup.

---

## C5.x — Client Ownership Migration

Completed:

- Client migrated from local ownership to server authority.

Completed migrations:

- Player data.
- Room metadata.
- Payment display.
- Setup timer ownership.

---

# Current Focus

Current work is related to:

TON financial integration and recovery architecture.

Main area:

PaymentSession lifecycle and GameEscrow interaction.

---

# Important Current Issue

PaymentSession rehydration gap was identified.

The problem:

After reconnect/recovery flow, payment state must be restored from authoritative sources.

Recovery must never invent payment state.

---

# Required Principles

Financial state:

- Durable.
- Verified.
- Blockchain-aware.

Gameplay state:

- Runtime state.
- Recoverable.
- Reconstructed from authoritative server state.

---

# Next Development Direction

Before continuing implementation:

1. Complete Cline onboarding.
2. Restore full project context.
3. Review existing architecture.
4. Continue only from validated state.

No architecture rewrite is allowed.