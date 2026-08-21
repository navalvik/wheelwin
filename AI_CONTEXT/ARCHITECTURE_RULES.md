# WheelWin Architecture Rules

## 1. Project Identity

WheelWin is a deterministic peer-versus-peer multiplayer game.

WheelWin is NOT a casino.

The system must never implement casino mechanics:
- No house player.
- No house edge.
- No RTP calculation.
- No weighted probabilities.
- No jackpot sectors.
- No bonus sectors.
- No hidden probability modifiers.

The game consists of exactly 3 players competing only against each other.

The server is an impartial referee, not a participant.

---

# 2. Core Authority Model

## Server Authority

The server becomes authoritative after:

GAME_INITIALIZED

After GAME_INITIALIZED:

- Server state is the single source of truth.
- Client state is only a projection of server state.
- Client must never decide game outcomes.
- Client must never calculate authoritative results.

The server owns:

- Room lifecycle.
- Player identity lifecycle.
- Payment state.
- Game configuration.
- Wheel physics state.
- Winner determination.
- Recovery decisions.

---

# 3. Client Rules

Client responsibilities:

- Render UI.
- Display server state.
- Send player inputs.
- Display animations.
- Play audio.

Client must NOT:

- Generate winners.
- Generate authoritative random values.
- Modify payment state.
- Create game configuration.
- Override server timers.
- Maintain independent gameplay truth.

---

# 4. Game Fairness Rules

All purchased sectors have equal probability.

Allowed:

- Server-side random assignment of sectors.
- Server-side icon assignment.
- Server-side color assignment.
- Deterministic physics.

Forbidden:

- Probability manipulation.
- Sector weighting.
- Dynamic balancing.
- Hidden bonuses.
- Player disadvantage mechanisms.

---

# 5. Architecture Preservation Rules

AI agents working on WheelWin must NOT:

- Rewrite architecture without explicit approval.
- Replace existing managers with simplified alternatives.
- Remove EventBus patterns.
- Merge domain boundaries.
- Move server authority into the client.
- Create parallel systems instead of fixing existing ones.

Prefer:

- Small incremental changes.
- Existing architecture reuse.
- Minimal surface modifications.
- Validation before modification.

---

# 6. Existing Domain Boundaries

Respect current modules:

## Room Domain

Responsible for:
- Room creation.
- Room lifecycle.
- Player slots.

## Player Domain

Responsible for:
- Player identity.
- Wallet binding.
- Player profiles.

## Payment Domain

Responsible for:
- Payment sessions.
- TON integration.
- Financial state.

## Configuration Domain

Responsible for:
- Immutable game configuration.
- Wheel configuration.
- Player sectors.

## Gameplay Domain

Responsible for:
- GameState.
- Physics.
- Input authority.
- Winner calculation.

## Recovery Domain

Responsible for:
- Restoring valid sessions.
- Never inventing financial state.

---

# 7. TON / Financial Rules

Financial state is durable.

Gameplay state is ephemeral.

Never:

- Modify blockchain facts.
- Create fake payment completion.
- Skip payment verification.
- Treat READY as completed payment.
- Trigger settlement without validated winner flow.

All financial transitions must be verified.

---

# 8. Development Workflow Rules

Every implementation step must:

1. Understand current architecture.
2. Identify existing ownership.
3. Make the smallest required change.
4. Validate behaviour.
5. Commit completed stage to Git.

Preferred workflow:

Analysis > Small Implementation > Validation > Git Commit

---

# 9. Testing Rules

Tests must verify:

- Existing architecture remains valid.
- No hidden side effects introduced.
- Recovery remains fail-closed.
- Server authority is preserved.

A passing test is not enough if architecture principles are violated.

---

# 10. AI Agent Operating Principle

When working on WheelWin:

Preserve the architecture.

Do not optimize away intentional complexity.

Complexity that exists because of domain separation is intentional.

The goal is production reliability, not minimum code size.