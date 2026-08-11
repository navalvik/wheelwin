# WheelWin Architecture Audit Baseline

**Purpose:** Permanent architecture memory for WheelWin.  
**Rule:** Future development chats must read this file first. Future audits must **not** repeat completed investigations listed here unless new evidence appears.

**Current HEAD (at baseline creation):** `47e3675` — R13.1H Harden financial lifecycle integrity

---

## 1. Project Principles

- Server is authoritative after `GAME_INITIALIZED`.
- Server owns the gameplay lifecycle.
- Client is presentation and input only.
- No casino mechanics.
- No house edge.
- Exactly three players.
- Equal sector probability.
- Financial truth comes from server + blockchain confirmation.

---

## 2. Completed Audits

### R12.5H — Page6 Lifecycle

**Status:** COMPLETED

**Result:**

- Page6 exit is controlled by FINISH.
- Timer removed from UX.
- Result Session remains the server cleanup mechanism.

### R13.0 — Production Architecture Audit

**Status:** COMPLETED

**Result:**

- Gameplay authority PASS.
- Payment authority PASS.
- Mainnet blocked until operational readiness and remaining issues are resolved.

### R13.1B — Room Protection

**Status:** COMPLETED

**Result:**

- Active gameplay cannot be destroyed by player leave.
- Offline players do not kill the gameplay lifecycle.

### R13.1C — Gameplay Immutability

**Status:** COMPLETED

**Result:**

- Game state is controlled by the server.
- Configuration freeze works.
- Client cannot modify gameplay authority.

### R13.1D / R13.1E — Identity Recovery

**Status:** COMPLETED

**Result:**

- `playerId` alone no longer grants recovery.
- Recovery credential implemented and required.

### R13.1F / R13.1G / R13.1H — Financial Lifecycle

**Status:** COMPLETED

**Result:**

- Payment authority protected.
- Wallet locked after payment confirmation.
- Financial snapshot frozen.
- Escrow lifecycle configuration frozen.

### R13.2 — Production Operational Readiness Audit

**Status:** COMPLETED (audit only)

**Result:**

- Verdict: READY WITH BLOCKERS for controlled Mainnet dry-run tooling/docs.
- Mainnet gameplay activation is **not** the next objective.
- Operational items remain PENDING (see §6).

---

## 3. Current Security Matrix

| Area | Status |
|------|--------|
| Gameplay authority | PASS |
| Room protection | PASS |
| Identity recovery | PASS |
| Payment authority | PASS |
| Wallet protection | PASS |
| Financial snapshot | PASS |
| Escrow lifecycle lock | PASS |
| Page6 lifecycle | PASS |

---

## 4. DO NOT RE-AUDIT LIST

The following areas were already audited and should **not** be repeated unless new evidence appears:

- Gameplay authority
- Physics authority
- Winner authority
- Page5 lifecycle ownership
- Page6 lifecycle
- Identity recovery
- Payment confirmation
- Wallet locking
- Financial snapshot
- Escrow lifecycle locking

---

## 5. Remaining Work Before Mainnet

**Mainnet is NOT ready and NOT the next objective.**

Mainnet is blocked until:

1. The owner gameplay / product issue list is completed.
2. The operational checklist is completed.
3. Live validation is completed.

Do **not** mark Mainnet ready.

WheelWin will **not** move to Mainnet until all owner-reported gameplay and product issues are resolved.

---

## 6. Known Operational Findings From R13.2

Remaining operational items (status: **PENDING**):

- Vercel / Railway production wiring confirmation
- Environment alignment confirmation
- Diagnostic endpoint protection
- Railway durable storage confirmation
- Mainnet checklist execution

These are operational/ops tasks. They do **not** reopen completed gameplay, identity, or financial authority audits.

---

## 7. Owner Reported Game Issues

### Gameplay / Product Issues Pending

> Priority: **above Mainnet**. Resolve these before any Mainnet work.

Space for future entries:

| ID | Observation | Area (UI / UX / gameplay / other) | Status |
|----|-------------|-------------------------------------|--------|
| | | | |
| | | | |
| | | | |

Notes:

- Future gameplay observations
- UI issues
- Player experience issues
- Manual test findings

---

## 8. Current Git State

**HEAD at baseline creation:**

```text
47e3675
R13.1H Harden financial lifecycle integrity
```

**C22 remains outside this work** (do not stage / do not mix into architecture commits):

- `client/src/components/game/CentralButton/centralButton.css`
- `client/src/game/centralButton/ButtonState.js`

---

## Maintenance

When a new architecture audit completes, append it under §2 with Status and Result, update §3 if verdicts change, and extend §4 only when a topic is fully closed.

When owner-reported issues are filed, add rows under §7.

Do not use this document to justify Mainnet enablement while §5 / §7 remain open.
