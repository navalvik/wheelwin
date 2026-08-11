# WheelWin Owner Gameplay Issues Register

**Purpose:** Official backlog for owner-reported gameplay and product issues.  
**Rule:** Future chats must read this file before starting new gameplay investigations.

**Related:** `docs/ARCHITECTURE_AUDIT_BASELINE.md` (architecture memory — do not re-audit closed security topics).

---

## Status Legend

| Status | Meaning |
|--------|---------|
| **OPEN** | Confirmed issue; fix not started |
| **AUDIT REQUIRED** | Inspect before changing code |
| **IN PROGRESS** | Active work |
| **FIXED** | Code change done; awaiting verification |
| **VERIFIED** | Confirmed closed |
| **BACKLOG** | Deferred; not current execution |

---

## Project Priority Rule

Mainnet is **NOT** the current objective.

WheelWin will not move to Mainnet until:

- all critical gameplay issues are resolved;
- manual player testing is completed;
- product issues are closed.

**Gameplay quality has priority over Mainnet preparation.**

---

## Critical Issues

### 1. Page5 — Wheel Brake Physics

**Status:** OPEN  
**Priority:** CRITICAL

**Problem:**

Current braking appears to calculate from maximum wheel speed.

**Required behavior:**

Brake must start from the actual current wheel velocity at the moment BRAKE begins.

**Required audit before fix:**

Determine:

- current velocity source;
- max/base velocity;
- BRAKE transition owner;
- value passed into deceleration;
- PhysicsEngine responsibility.

Do **not** rewrite physics without audit.

---

### 2. Page5 — Audio System

**Status:** OPEN  
**Priority:** CRITICAL

**Problem:**

Current game sound source is unclear.

**Required audit:**

Determine:

- Audio API used;
- sound source;
- generated audio vs audio file;
- trigger points;
- synchronization with game phases.

**Requirement:**

Gameplay sound must come from an audio file asset.

---

## Page5 Controls

### 3. Central Button Audit

**Status:** AUDIT REQUIRED

**Scope:**

Audit:

- colors;
- active/inactive state;
- click behavior;
- commands sent;
- server reaction;
- visual state vs authoritative state.

**Important:**

Existing C22 files remain separate:

- `client/src/components/game/CentralButton/centralButton.css`
- `client/src/game/centralButton/ButtonState.js`

Do not mix C22 changes into unrelated commits.

**Additional requirement:**

Replace current green color.

New button color must not match any wheel sector color.

First inspect existing color catalog.

Do not choose randomly.

---

## Page4

### 4. Remove CANCEL Button

**Status:** OPEN

**Requirement:**

Remove CANCEL from production UI.

**Verify:**

- payment lifecycle;
- recovery;
- server payment logic.

No functional regression allowed.

---

## Page6

### 5. Remove Large Game Log Window

**Status:** OPEN

**Current:**

- Game Log window;
- Download JSON;
- Download TXT.

**Required:**

Keep only:

- Download TXT

Remove:

- large log window;
- JSON download.

---

### 6. Page6 Result Session Countdown

**Status:** OPEN

**Requirement:**

Show visible remaining Result Session lifetime.

**Existing architecture:**

Server authoritative 5 minute Result Session.

**Required behavior:**

```text
Player A presses FINISH
        ↓
A returns Page1

Players B/C remain Page6

Countdown continues

Result Session expires

B/C return Page1
```

Countdown must only display the server deadline.

Do **not** create a client-owned lifecycle timer.

---

## Storage

### 7. Session History Cloud Storage

**Status:** AUDIT REQUIRED

**Current:**

`data/session-history/`

**Problem:**

Railway filesystem may be ephemeral.

**Before implementation audit:**

Determine:

- Google Cloud Storage design;
- bucket;
- authentication;
- naming;
- retention;
- upload timing;
- retries;
- idempotency;
- local cache;
- retrieval.

No implementation before architecture approval.

---

## Testing

### 8. Telegram Real Device Testing

**Status:** IN PROGRESS

Continue:

- 3 devices;
- Telegram WebView;
- background/foreground;
- reconnect;
- offline player;
- completion flow.

---

## Product Tasks

### 9. Localization

**Status:** BACKLOG

---

### 10. Telegram Adaptation

**Status:** BACKLOG

Review:

- UI;
- user flow;
- Telegram environment.

---

### 11. YouTube Educational Content

**Status:** BACKLOG

Separate product direction.

Do not mix with gameplay fixes.

---

### 12. Advertising Banner

**Status:** AUDIT REQUIRED

**Before implementation audit:**

Determine:

- location;
- dimensions;
- affected pages;
- source;
- fallback;
- desktop/mobile behavior;
- Telegram layout impact.

Do not integrate an advertising network yet.

---

## Future Version

### 13. Wheel Visual Jerking

**Status:** BACKLOG

**Decision:**

Do not fix in the current version.

Move to a future game version.

---

## Current Execution Order

1. Page5 BRAKE audit  
2. Page5 BRAKE fix  
3. Page5 AUDIO audit  
4. Page5 AUDIO fix  
5. Central Button audit  
6. Central Button fix  
7. Page4 CANCEL removal  
8. Page6 Game Log cleanup  
9. Page6 countdown implementation  
10. Session History Cloud architecture audit  
11. Telegram E2E testing  
12. Localization  
13. Telegram adaptation  
14. YouTube  
15. Advertising  
16. Wheel visual jerking (future version)

---

## Mainnet Status

**NOT STARTED.**

Blocked until owner gameplay issues are resolved.

---

## Maintenance

When an issue changes state, update its **Status** field and note the date/commit if fixed.

New owner observations should be appended under the appropriate section (or as new numbered items) with Status = OPEN or AUDIT REQUIRED.
