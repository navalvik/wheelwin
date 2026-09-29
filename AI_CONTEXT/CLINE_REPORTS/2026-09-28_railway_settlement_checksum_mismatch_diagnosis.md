# Railway Testnet Startup Failure — Settlement Record `checksum_mismatch` Diagnosis

Date: 2026-09-28

Task: Diagnosis-only analysis of the Railway Testnet backend startup crash on
deployment `5aa56589bbe20cbbbd0713d0ba73a7dd73459d43`
(`feat(payment): commit authoritative room network propagation`):
`CorruptedRecordError: Financial record corrupted | type=settlement |
id=game_564c9603-41fd-4d0e-a357-e0cff44bf46b | reason=checksum_mismatch`
from `TonFinancialPersistence.restore` → `initialize` →
`WheelWinApplication.start`. No code, data, or configuration was modified.

## 1. Scope

- Exact implementation of `TonFinancialPersistence` restore/initialize, the
  checksum algorithm, envelope validation, and the atomic write path.
- Settlement persistence format/schema and the full Room-Wallet settlement
  write path (`SettlementSession.toPayload` → `_persistSession` →
  `createSettlementRecord`/`updateSettlementRecord`), including boot-time
  re-persist paths (`restoreSettlementSessions`,
  `_reenterHistoricalRoomWalletFailure`).
- Git history of the persistence and settlement files; server-side diff
  between the previous deployment base and the failing deployment.
- Empirical, read-only reproduction of the failure mechanism using the real
  production functions against the local persistence store.
- Explicitly out of scope (untouched): Railway variables, deployments,
  production data, Mainnet, smart-contract payment logic (the legacy
  GameEscrow branches observed in the settlement manager remain inert behind
  `_isRoomWalletSettlementActive()` and were not restored or reactivated).

## 2. Files Inspected

- `server/persistence/TonFinancialPersistence.js` (restore 339–460, create/
  update 131–226, checkpoint 462–489, storage layout and atomic IO 1240–1385,
  typed settlement APIs 960–983)
- `server/persistence/tonFinancialRecordUtils.js` (full — `stableStringify`,
  `computePayloadChecksum`, `resolveRecordId`, `buildRecordEnvelope`,
  `validateRecordEnvelope`, `cloneEnvelopeForUpdate`)
- `server/persistence/TonFinancialRecordTypes.js` (full — schema version 1,
  record types, terminal statuses, storage categories)
- `server/persistence/TonFinancialPersistenceErrors.js` (error message format)
- `server/payment/ContractSettlementManager.js` (restore 460–560,
  `_reenterHistoricalRoomWalletFailure` 567–610, resume context 887–985,
  winner-determined entry 1615–1690, `_resolveRoomNumberForSettlement`
  1711–1780, durable handoff 1811–1891, adapter-advance 1893–1935, fail path
  3212–3250, `_persistSession` 3435–3480, `_validateSettlement` 2345–2627)
- `server/payment/SettlementSession.js` (full — constructor, `fromRecord`,
  `applyPatch`, `toPayload`, `transitionTo`)
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js` (full)
- `server/payment/roomWallet/historicalRoomWalletSettlementReentry.js` (full)
- `server/models/GameContract.js` (snapshot accessors, grep-level)
- Local persistence store `server/data/ton-financial/**` (read-only scan of
  all 192 record files; `active/settlement/` is empty locally)
- Git: `git log -- server/persistence/`, `git log` for settlement files,
  `git diff --stat dfa8832..5aa5658 -- server/`

## 3. Architecture Findings

### Checksum algorithm (exact)

- `checksum = SHA-256 hex( stableStringify( payload ?? {} ) )`
  (`computePayloadChecksum`, `tonFinancialRecordUtils.js:55`).
- `stableStringify` recursively sorts object keys; arrays keep order;
  scalars via `JSON.stringify`.
- Envelope: `{ recordType, recordId, createdAt, updatedAt, version, status,
  correlationId, roomId, gameId, contractId, tonNetwork, immutable, checksum,
  payload }`; `version` must equal `TON_FINANCIAL_SCHEMA_VERSION = 1`.
- Validation (`validateRecordEnvelope`) recomputes the checksum from the
  **in-memory payload object as parsed from the stored JSON** and compares it
  to the stored `checksum` field.

### Restore behaviour (exact)

`restore()` (TonFinancialPersistence.js:339) iterates every record type
directory, `JSON.parse`s each file, and **throws `CorruptedRecordError`
immediately on the first envelope with validation errors** (line 396; reason
= validation errors joined — the production message shows only
`checksum_mismatch`, proving the schema-version check passed). This
fail-closed behaviour is intentional financial-integrity design and is what
converts the single bad record into a full startup crash.

### Write path (exact)

`_writeJsonAtomic` writes to `<file>.<pid>.<ts>.tmp` then `renameSync` —
record-level atomic. A crash mid-write can never leave a torn target file.
`_persistSession` (ContractSettlementManager.js:3435) persists
`session.toPayload()` with gameId-keyed metadata; its catch block swallows
all write errors except the `RecordNotFoundError` → create retry.

### The divergence mechanism (root-cause class — empirically proven)

The checksum is computed over the **in-memory** payload, but the file stores
the **JSON-serialized** payload. For value shapes where the two
representations differ, the stored checksum describes a payload that does not
match the persisted one — deterministically, on every restore, on every code
version:

- A key whose in-memory value is `undefined` is **hashed as
  `"key":undefined`** by `stableStringify`, but **omitted entirely** by
  `JSON.stringify` on disk.
- A `Date` object hashes as `"{}"` (own enumerable keys) but persists as an
  ISO string.
- An object with `toJSON()` (BN/TonConnect types) hashes by own enumerable
  props but persists via `toJSON()` output.

Read-only reproduction with the real production modules
(`SettlementSession.toPayload()` + `computePayloadChecksum` +
`validateRecordEnvelope`):

| Case | Payload | Result |
|---|---|---|
| E | Fully-provided session (exact `_createDurableSettlementHandoff` shape) | OK — round-trip stable |
| G | `winnerId`/`winnerWallet`/`prizeAmount` undefined | **CHECKSUM_MISMATCH** — `OMITTED_ON_DISK winnerId, winnerWallet, prizeAmount, winnerAmount`; mem-sha256 `a2d402cf…`, disk-sha256 `49b9148b…` |
| H | Nested `undefined` key inside `request` | **CHECKSUM_MISMATCH** — `OMITTED_ON_DISK request.nested.b` |

### Reachable divergent-value vectors in the settlement write path

1. `SettlementSession` constructor null-coerces ~15 fields with `?? null` but
   leaves `winnerId`, `winnerWallet`, `prizeAmount` **uncoerced**; `toPayload()`
   emits them verbatim. Any persist while one of these is `undefined`
   produces the divergence (case G).
2. `request` and `recoveryMetadata` are arbitrary nested objects on the
   payload; any `undefined` key, `Date`, or `toJSON` value anywhere inside
   them causes the divergence (case H).
3. The durable handoff (`_createDurableSettlementHandoff` 1836–1853) embeds
   `snapshot: contract.snapshot` and `contract.contractAddress` /
   `contract.contractId` into the frozen `request` with no per-field
   null-coercion — safe in the current Room-Wallet stub-contract shape
   (explicit `null`s, `_validateSettlement` 2407–2424), but any older revision
   that could leave these `undefined` writes records that fail forever.

### Why this deployment exposed it

`git diff --stat dfa8832..5aa5658 -- server/` touches only
`PaymentSessionManager.js`, `RoomLobbyBridge.js`, and two new test files —
**no persistence, checksum, or settlement code changed** in the failing
deployment; `server/persistence/` last changed at `53fe3ba` (additive
`setup_session` type). The failing record was written during the **previous**
deployment's uptime by whatever revision Railway ran then; deploying
`5aa5658` caused the first process restart since that record was written,
which is when the deterministic divergence first surfaced. The record fails
restore on every boot on any revision until repaired.

### Comparison with valid records

- All **192 locally persisted records** (deposit_session, game_contract,
  payment_session, audit, deposit_observation, snapshot, deployment_*) were
  validated read-only with the current algorithm: **192/192 pass, 0 failures**
  — the algorithm and schema version are healthy; no systemic
  incompatibility.
- Case E (fully-provided settlement payload, the current Room-Wallet happy
  path) round-trips stable — records written by the current null-safe path
  validate correctly.
- The failing record itself does **not** exist anywhere in the local
  repository or local store; it lives only on the Railway volume at
  `<dataDir>/active/settlement/game_564c9603-41fd-4d0e-a357-e0cff44bf46b.json`
  (settlement records are `active`-category, gameId-keyed files).

## 4. Lifecycle Flow

1. Server boots → `WheelWinApplication.start` →
   `TonFinancialPersistence.initialize` → `_ensureStorageLayout` →
   `_loadManifest` → `restore()`.
2. `restore()` scans every record directory; reaches
   `active/settlement/game_564c9603-41fd-4d0e-a357-e0cff44bf46b.json`.
3. `validateRecordEnvelope` recomputes `SHA-256(stableStringify(payload))`
   from the parsed payload; the stored `checksum` differs →
   `["checksum_mismatch"]`.
4. `restore()` throws `CorruptedRecordError` immediately (fail-closed) →
   process exits → Railway restart loop. The crash reproduces on every boot,
   independent of code revision, until the record is repaired.

## 5. Ownership Boundaries

- Persistence integrity remains owned by `TonFinancialPersistence`
  (passive durable storage); settlement lifecycle by
  `ContractSettlementManager` + `SettlementSession`; record envelope
  invariants by `tonFinancialRecordUtils`. Nothing moved.
- The diagnosis introduced no parallel recovery flow, no validation bypass,
  and did not touch Mainnet, Vercel, Railway, or any environment variable.

## 6. Risks

- Critical: production Testnet backend is in a restart loop — no settlement,
  payment, or gameplay service is available while the record fails restore.
- High: **other divergent records may be hidden behind the first failure** —
  `restore()` stops at the first `CorruptedRecordError`, so the remaining
  settlement records on the Railway volume have not been validated; the true
  number of affected records is unknown until the volume is scanned.
- Medium: the same write-path divergence class will silently re-create
  broken records whenever a settlement payload is persisted while it contains
  an `undefined`/`Date`/`toJSON` value — including via the boot-time
  `_reenterHistoricalRoomWalletFailure` re-persist and any retry/resume
  re-persist of restored sessions.
- Low: `_persistSession` swallows write errors (other than the retried
  create), so persistence failures do not surface at settlement time.
- Low: local git history is shallow (grafted at `4c76510`), so the exact
  writer revision that produced the record could not be inspected.

## 7. Recommendations

Root cause verdict: the deterministic write-path divergence
(stored checksum computed over an in-memory payload containing at least one
`undefined`-valued key — most plausibly `winnerId`/`winnerWallet`/
`prizeAmount` or a nested `request`/`recoveryMetadata` key — or, less likely,
a `Date`/`toJSON` value) is **proven reproducible with the production code**
and is the only mechanism consistent with a valid-JSON file failing pure
`checksum_mismatch` under atomic writes. **The exact field inside the
production record remains unconfirmed** until the file is read from the
Railway volume; genuine external/volume corruption cannot be fully excluded
without it, but is made unlikely by the atomic write design.

Isolated vs systemic: **record-specific, not algorithmic/systemic.** 192/192
local records validate; schema version is unchanged; the failing deployment
changed no persistence code. However, an unknown number of additional
records on the Railway volume may share the defect (restore stops at the
first failure).

Safest minimal remediation direction (none performed in this stage):

1. **Preserve first:** copy the failing file off the Railway volume
   (`active/settlement/game_564c9603-….json`) — read-only. Do not delete or
   reset it; it is settlement evidence keyed to a real game.
2. **Confirm:** diff its `payload` key-set against the settlement audit
   trail; an audit-proven field that is absent from the JSON confirms the
   `undefined`-omission cause. Also run a full-volume record scan to
   enumerate any additional failing records.
3. **Repair the record deterministically (approved one-off operation):**
   re-seal the envelope by recomputing
   `checksum = computePayloadChecksum(storedPayload)` over the **exact
   stored payload** (payload bytes unchanged; only the checksum field is
   corrected to describe the data actually present). This preserves every
   financial value 1:1, keeps checksum validation fully enabled, and is not
   a bypass. Back up the original file first; do it for each record the scan
   identifies.
4. **Harden the writer (separate code stage, not this one):** null-coerce
   `winnerId`/`winnerWallet`/`prizeAmount` in the `SettlementSession`
   constructor (matching its other fields) and/or compute envelope checksums
   over the JSON-round-tripped payload
   (`JSON.parse(JSON.stringify(payload))`) so write-time and restore-time
   hashing can never diverge; consider a focused regression test for the
   undefined-field round-trip.
5. Do not disable checksum validation, do not add a production bypass, do
   not restore smart-contract payment logic; the fail-closed boot is correct
   behaviour and should remain.

## 8. Changes Made

**No files, data, records, or code were modified.** No commits were created;
nothing was pushed; no Railway/Vercel/Mainnet configuration was touched. The
only filesystem activity was a read-only scan of the local persistence store
plus temporary diagnosis scripts created outside the repository
(`C:\Users\Public\`), which were deleted afterwards. This report is the sole
artifact produced.


