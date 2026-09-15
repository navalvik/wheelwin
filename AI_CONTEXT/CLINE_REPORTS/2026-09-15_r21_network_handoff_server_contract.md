# R21 — Cross-Runtime Room Network Handoff: Server Contract Only

Date: 2026-09-15

Task: Implement ONLY the server-side foundation for the cross-runtime
room-network handoff (Testnet → Mainnet): wire the existing
`RoomNetworkHandoffStore` into the Testnet runtime, expose a narrowly scoped
authenticated internal HTTP contract (`claim` / `complete`), provide the
Mainnet-side HTTP client for that contract, fail-closed shared-secret
authentication, focused tests, and this single report. Branch:
`payment/room-wallet-integration` (based on the previous slice commit
`52ec698` "lobby: add owner network selection").

Commit: ONE commit — `network: add cross-runtime room handoff contract`
(exact SHA is the branch tip produced by this single commit; a commit cannot
contain its own SHA, so the authoritative SHA is recorded in the delivery
summary of this slice and verifiable via `git rev-parse HEAD` on the branch).

## 1. Scope

Implemented in this slice:

- `RoomNetworkHandoffStore` wired as exactly ONE instance per Testnet
  application runtime (no per-request instantiation, no persistence, no
  database — the store stays in-memory and intentional).
- Dedicated internal HTTP route module on Testnet:
  `POST /internal/network-handoff/claim` and
  `POST /internal/network-handoff/complete`.
- Dedicated shared-secret internal authentication, fail-closed.
- Mainnet-side reusable HTTP client service for the Testnet contract.
- Focused HTTP-contract tests.
- `.env.example` documentation for both new environment variables.

Explicitly NOT implemented (per task):

- Browser/client navigation to Mainnet (no `openTelegramLink`, no
  `postEvent`, no `handoff_...` startapp payload, no Page1/Page2/Page3 UI
  changes).
- Mainnet room bootstrap from the handoff.
- Live Room/Game runtime migration (forbidden by architecture).
- Any `network` property added to `Room.js` (untouched).
- Any `/debug/*` or `/console/*` surface (the abandoned wallet-monitoring
  direction remains untouched).
- Triggering `handoffStore.create()` from RoomLobbyBridge (deferred to the
  next slice; the dependency is wired cleanly for it, see §5).

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`,
  `CURRENT_STATE.md`, `AI_WORKING_RULES.md` (per pre-analysis rule)
- `AI_CONTEXT/CLINE_REPORTS/2026-09-14_r20_network_selection_owner_implementation.md`
- `server/network/RoomNetworkHandoffStore.js` (store semantics preserved as-is)
- `server/app.js` (runtime/service construction, route registration points)
- `server/console/registerDeveloperConsoleRoutes.js` (Express conventions;
  NOT modified)
- `server/tests/roomNetworkSelection.r20.test.js`,
  `server/tests/secretMatrix.status.test.js` (test harness conventions)
- `server/scripts/run-tests.js` (auto-discovery of `tests/*.test.js`)
- `server/.env.example`, `server/package.json` (Node 24, ESM, Express 4)

## 3. Architecture Findings

- The previous slice (r20) made the owner's network selection authoritative
  and one-time in `RoomLobbyBridge` but intentionally left
  `RoomNetworkHandoffStore` unwired. This slice wires the store at the
  application-runtime level without touching `RoomLobbyBridge`.
- `app.js` constructs all services in one initialization method and registers
  route modules on `this._expressApp`; the handoff store and its routes
  follow exactly this established pattern (additive, after the Developer
  Console routes block).
- Express body parsing (`express.json({ limit: "32kb" })`) already exists
  globally, so the new POST routes need no parser changes.
- The store's own semantics (2-minute TTL, 30-second claim lease, one-time
  completion, idempotent completed state) were preserved unchanged — no
  redesign was needed and none was made.

## 4. Lifecycle Flow (this slice)

```
(Testnet runtime boot, app.js)
  -> new RoomNetworkHandoffStore()  [exactly one instance]
  -> registerRoomNetworkHandoffRoutes(expressApp, { handoffStore, logger })
       -> reads ROOM_NETWORK_HANDOFF_SECRET (fail closed if unset)

(Mainnet service, NEXT slice, already available now)
  -> new RoomNetworkHandoffClient()  [env-configured]
  -> claim({ handoffId, ownerTelegramUserId })
       -> Testnet: header auth -> shape validation -> store.claim()
  -> (Mainnet creates its own ordinary authenticated room — NOT in this slice)
  -> complete({ handoffId, ownerTelegramUserId, mainnetRoomId })
       -> Testnet: header auth -> shape validation -> store.complete()
```

Room creation of the handoff record (`store.create(...)`) is intentionally
NOT triggered yet; the next slice (RoomLobbyBridge MAINNET-selection wiring)
will call the same single instance exposed via
`WheelWinServer#getRoomNetworkHandoffStore()`.

## 5. Ownership Boundaries

- `RoomNetworkHandoffStore` — record ownership/state machine (unchanged).
- `registerRoomNetworkHandoffRoutes.js` — owns the Testnet HTTP contract
  surface: authentication, request-shape validation, status mapping. It never
  mutates handoff state directly; it only delegates to the store.
- `RoomNetworkHandoffClient.js` — owns the Mainnet-side calling contract
  (configuration resolution, timeout, normalized results). It knows no
  gameplay/payment state.
- `app.js` — owns construction/wiring only (one store instance, one route
  registration, one getter).
- No gameplay, payment, wallet, physics, clock, or recovery module was
  touched. `Room.js` untouched. No parallel implementations created.

## 6. Contracts Introduced

### 6.1 Testnet handoff route contract

Module: `server/network/registerRoomNetworkHandoffRoutes.js`
Registration: `registerRoomNetworkHandoffRoutes(app, { handoffStore, logger, secret })`
(`secret` defaults to `resolveRoomNetworkHandoffSecret(process.env)`).

`POST /internal/network-handoff/claim`

- Request body (only): `{ "handoffId": "...", "ownerTelegramUserId": "..." }`
- Caller-supplied `ownerPlayerId`, `roomId`, `network`, `targetNetwork`,
  `mainnetRoomId` are rejected with `400 FORBIDDEN_FIELD` (identity comes
  exclusively from the handoff record).
- Responses:
  - `200 { ok: true, state: "claimed", mainnetRoomId: null }`
  - `200 { ok: true, state: "completed", mainnetRoomId: "..." }` (idempotent
    store semantics for an already-completed handoff)
  - `404 { ok: false, reason: "NOT_FOUND_OR_EXPIRED" }`
  - `403 { ok: false, reason: "OWNER_MISMATCH" }`
  - `400 { ok: false, reason: "INVALID_REQUEST" | "FORBIDDEN_FIELD" }`
  - `401 { ok: false, reason: "UNAUTHORIZED" }` (bad/missing secret)
  - `503 { ok: false, reason: "HANDOFF_NOT_CONFIGURED" }` (secret unset —
    fail closed)

`POST /internal/network-handoff/complete`

- Request body (only):
  `{ "handoffId": "...", "ownerTelegramUserId": "...", "mainnetRoomId": "..." }`
- Caller-supplied `ownerPlayerId`, `roomId`, `network`, `targetNetwork` are
  rejected (`400 FORBIDDEN_FIELD`). The Testnet room id is NEVER accepted
  from the caller.
- Responses:
  - `200 { ok: true, state: "completed", mainnetRoomId: "..." }`
  - `404 NOT_FOUND_OR_EXPIRED`, `403 OWNER_MISMATCH`,
    `409 CLAIM_REQUIRED` (no active claim / expired lease),
    `422 INVALID_MAINNET_ROOM_ID` (empty id),
    `400 INVALID_REQUEST | FORBIDDEN_FIELD`,
    `401 UNAUTHORIZED`, `503 HANDOFF_NOT_CONFIGURED`
- Repeated completion stays idempotent per store semantics: the authoritative
  `mainnetRoomId` of the first completion is never overwritten.

Internal record fields (`ownerPlayerId`, Testnet `roomId`, expiry detail) are
never exposed in any response.

Shared protocol constants (header, endpoints, reason codes) live in
`server/network/roomNetworkHandoffProtocol.js` so the Testnet routes and the
Mainnet client cannot drift apart.

### 6.2 Mainnet handoff client contract

Module: `server/network/RoomNetworkHandoffClient.js` (runs on the MAINNET
service; reusable by the next slice that performs Mainnet bootstrap).

- `new RoomNetworkHandoffClient({ baseUrl?, secret?, timeoutMs?, fetchImpl? })`
  — options default to environment resolution; `fetchImpl` injectable for
  tests.
- `client.isConfigured()` — true only when base URL AND secret AND a fetch
  implementation exist.
- `await client.claim({ handoffId, ownerTelegramUserId })`
- `await client.complete({ handoffId, ownerTelegramUserId, mainnetRoomId })`
- Normalized results (never throws for remote failures):
  - `{ ok: true, state, mainnetRoomId }` on 2xx
  - `{ ok: false, reason: "HANDOFF_CLIENT_NOT_CONFIGURED" }` — fail closed,
    no network activity
  - `{ ok: false, reason: <Testnet reason code> | "HTTP_<status>" }` with
    `httpStatus` on non-2xx
  - `{ ok: false, reason: "TIMEOUT" | "NETWORK_ERROR" }` on transport
    failures (default timeout 10 s via `AbortController`)

## 7. Environment Variables Introduced

- `ROOM_NETWORK_HANDOFF_SECRET`
  - Shared server-to-server secret between the Testnet and Mainnet Railway
    services; MUST be identical on both.
  - Carried in the dedicated request header
    `x-wheelwin-network-handoff-secret`.
  - NOT a developer-console credential, NOT a Telegram bot token, NOT a
    wallet secret. Not hard-coded; documented in `server/.env.example`.
  - Unset on Testnet ⇒ handoff endpoints reject ALL requests (fail closed).
- `ROOM_NETWORK_HANDOFF_TESTNET_URL`
  - Mainnet side only: base URL of the Testnet service that owns handoff
    records (Railway URL supplied via environment; never hard-coded, never
    assumed localhost). Unset ⇒ Mainnet client fails closed with no network
    calls.

## 8. Authentication / Security Behavior

- Authentication happens BEFORE any handoff-store invocation.
- Constant-time comparison: both the received and expected secrets are
  SHA-256 hashed and compared with `crypto.timingSafeEqual`, eliminating
  length-based early exits and `timingSafeEqual` length-throw behavior.
- Fail closed:
  - Testnet with unset secret ⇒ `503 HANDOFF_NOT_CONFIGURED` for every
    request (endpoints never accept unauthenticated traffic).
  - Mainnet client with missing URL or secret ⇒ normalized failure with
    zero network activity (asserted with a fetch stub that throws if called).
- The secret is never logged (only reason codes and coarse security events
  are logged), never included in any response body, and never returned to
  client code by the Mainnet client.
- Identity boundary preserved: the ONLY ownership proof at the claim boundary
  is the Telegram user id independently authenticated by Mainnet and matched
  against the handoff record. `startapp`, `initDataUnsafe`, browser-supplied
  Telegram ids, `roomId`, and `playerId` prove nothing; caller-supplied
  identity fields are structurally rejected (`FORBIDDEN_FIELD`).
- Testnet initData is never forwarded or replayed to Mainnet by this slice
  (no client code exists yet — by design).

## 9. Files Changed

- `server/network/roomNetworkHandoffProtocol.js` — NEW: shared protocol
  constants (secret header, endpoints, reason codes, env var names).
- `server/network/registerRoomNetworkHandoffRoutes.js` — NEW: Testnet
  internal HTTP contract (claim/complete), fail-closed auth, shape
  validation, status mapping, secret resolution helper.
- `server/network/RoomNetworkHandoffClient.js` — NEW: Mainnet-side HTTP
  client service (env-configured, fail closed, timeout, normalized results).
- `server/network/RoomNetworkHandoffStore.js` — UNCHANGED (semantics kept).
- `server/app.js` — additive wiring only: two imports, one
  `RoomNetworkHandoffStore` instance, one `registerRoomNetworkHandoffRoutes`
  call, one startup line, and the public
  `getRoomNetworkHandoffStore()` accessor for the next slice. No wholesale
  rewrite (targeted edits only).
- `server/.env.example` — documented the two new environment variables.
- `server/tests/roomNetworkHandoff.r21.test.js` — NEW: 13 focused test
  blocks covering the whole contract (see §10).
- `AI_CONTEXT/CLINE_REPORTS/2026-09-15_r21_network_handoff_server_contract.md`
  — NEW: this report (the only report/architecture document produced).

## 10. Tests Executed and Results

Runner: plain Node (project convention; tests auto-discovered by
`server/scripts/run-tests.js`).

| Suite | Result |
|---|---|
| `tests/roomNetworkHandoff.r21.test.js` (NEW) | exit 0 — 13/13 blocks passed (details below) |
| `tests/roomNetworkSelection.r20.test.js` (r20 regression) | exit 0 — all assertions passed (pre-existing shutdown-forensics log noise only) |
| `tests/roomCreationTelegramAuthorization.r179t6c.test.js` (r17.9T.6-C regression) | exit 0 — all assertions passed |
| `node --check` on `app.js` + 4 new/edited network modules | no syntax errors |

New-test coverage detail: 1 claim success; 2 wrong identity; 3 wrong/missing
secret (lease unconsumed); 4 expired/nonexistent (injectable clock); 5
complete success; 6 complete without claim (`409`); 7 complete wrong
identity; 8 idempotent repeated completion (first `mainnetRoomId`
authoritative, never overwritten); 9a routes fail closed without secret
(`503`); 9b client/env fail closed (fetch stub proves zero network calls;
trailing-slash stripping); 10 secret never in response bodies or logs; 11
forged ownership fields rejected (`ownerPlayerId` / `roomId` / `network` /
mainnet-room-id-on-claim ⇒ `400 FORBIDDEN_FIELD`; array body ⇒ `400
INVALID_REQUEST`); 12 Mainnet client ↔ Testnet routes end-to-end (claim,
wrong-owner, complete, wrong-secret client, unreachable Testnet ⇒
`NETWORK_ERROR`).

Notes: tests spin up real Express servers on ephemeral ports and use
`fetch` (Node 24). The r20 network-selection and CREATE_ROOM authorization
tests were NOT weakened or rewritten.

## 11. Explicit Boundary Statement

Browser/client handoff navigation and Mainnet room bootstrap are NOT
implemented in this slice. No `openTelegramLink`, no `postEvent`, no
`startapp` payload, no Mainnet Page1/Page2 UI changes, no Page3/payment/
gameplay changes, no live Room migration, no `Room.js` changes. This slice
stops at the verified server-to-server contract.

## 12. Blockers / Deviations

1. Workspace topology (resolved): the `payment/room-wallet-integration`
   branch is checked out in a dedicated git worktree at `G:\WheelWin_r20`
   (the main `G:\WheelWin` worktree is on `mainnet/production`). The slice
   was therefore implemented and committed in `G:\WheelWin_r20`. The main
   worktree carried unrelated WIP (mainnet testnet-warning changes) which
   CONFLICTED with a checkout; it was preserved via
   `git stash push -m "preserve mainnet WIP during r21 handoff slice"`
   (tracked files only; untracked files untouched) and can be restored with
   `git stash pop` on `mainnet/production`. It is NOT part of this commit.
2. Self-referential SHA: a commit cannot contain its own SHA. The report
   contains the exact commit message; the exact SHA of the single commit is
   delivered in the implementation summary and verifiable via
   `git rev-parse HEAD` on the branch.
3. Genuine correctness defect found by the new tests (fixed in this slice's
   new code only, not in the store): the initially shared forbidden-field
   list wrongly rejected the legitimate `mainnetRoomId` on COMPLETE; the
   forbidden lists are now separate (`CLAIM_FORBIDDEN_FIELDS` vs
   `FORBIDDEN_IDENTITY_FIELDS`). The store itself needed no changes.

## 13. Recommendations (next stage only)

1. Next slice: trigger `handoffStore.create(...)` from the existing
   RoomLobbyBridge MAINNET-selection handler using `_roomCreators` + the
   trusted Telegram identity resolver, and deliver the opaque `handoffId`
   to the creator socket only.
2. Next slice: Mainnet bootstrap — authenticate Telegram initData normally,
   claim via `RoomNetworkHandoffClient`, create the new ordinary Mainnet
   room, then call `complete`; only afterwards close/release the Testnet
   source room.
3. Keep `ROOM_NETWORK_HANDOFF_SECRET` out of any client bundle; set it only
   in both Railway services' private environments.

## 14. Changes Made

Committed as ONE commit on `payment/room-wallet-integration`:
`network: add cross-runtime room handoff contract`. No push performed (per
instruction). Exactly one report file created (this document). No other
report or architecture notes scattered elsewhere.





