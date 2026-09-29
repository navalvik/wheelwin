# 5d7V Payment Incident — Blockchain Timestamp Verification

Date: 2026-09-28

Task: Factual, read-only verification for the 5d7V payment incident. Determine — from the
existing archived/project data only — whether the TON blockchain creation timestamps (`utime`)
are available for three exact transactions of PaymentSession
`pay_27d9320d-fb26-4909-972e-80c0878091b2`, and whether each transaction was created BEFORE or
AFTER the PaymentSession started. No fix, no commit, no Railway access, no TON blockchain query,
no additional audit.

---

## 1. Scope

- PaymentSession: `pay_27d9320d-fb26-4909-972e-80c0878091b2`
- createdAt: `1790578640023` ms = 2026-09-28 09:57:20.023 local time (UTC+3)
  = 2026-09-28 06:57:20.023 UTC
- Transactions checked (both base64 and hex forms):

| # | Participant | txHash (base64) | txHash (hex) |
|---|---|---|---|
| 1 | Bob | `4N0GQryvoY4HawlTzkrmKo8UAbOVBWYdfbd+71EDSJQ=` | `e0dd0642bcafa18e076b0953ce4ae62a8f1401b39505661d7db77eef51034894` |
| 2 | Olga | `Ag4w6NukSTypq08HkaIw0E9W06BwQ0pJBbjy60a5wGk=` | `020e30e8dba4493ca9ab4f0791a230d04f56d3a070434a4905b8f2eb46b9c069` |
| 3 | Lena | `ZnrmAbEpybGoyg0zBVoEedEZV0txpV6OZH9b8f+XKfI=` | `667ae601b129c9b1a8ca0d33055a0479d119574b71a55e8e647f5bf1ff9729f2` |

---

## 2. Search Coverage (existing archived/project data, read-only)

| Evidence location | Method | Result |
|---|---|---|
| Indexed repository — 4957 files: all source, `AI_CONTEXT/CLINE_REPORTS/`, `docs/`, `.kilo/worktrees/` copy | indexed regex search | **zero** matches for room `5d7V`, session `pay_27d9320d`, and all three hashes (base64 **and** hex forms) |
| `server/data/ton-financial/` (local financial persistence, incl. `immutable/audit/rwin__{destination}__{txHash}.json` observation records with the tx hash embedded in the filename) | indexed + filename/content search | 5d7V observation records **not present locally** (the incident session lived on the Railway volume) |
| `server/data/session-history/` + `index.json` | indexed search | no 5d7V session archive (latest local archives are 2026-08-28 and earlier) |
| `server/logs/` (only `test-weborigin.exit`, `test-weborigin.out`) | direct read | local test trace only (room `n2C4`, 2026-09-20) — no TON transaction data |

Index coverage was proven before relying on zero-results: control strings known to exist inside
`server/data` (`dauth_08842679…`, `game_e4285df3…`) were found by the same indexed search.

---

## 3. Verification Result

| # | Participant | txHash | utime in archived/project data? | Blockchain timestamp | BEFORE / AFTER session start |
|---|---|---|---|---|---|
| 1 | Bob | `4N0GQryvoY4HawlTzkrmKo8UAbOVBWYdfbd+71EDSJQ=` (hex `e0dd0642…034894`) | **NOT FOUND** | — | **UNDETERMINABLE** |
| 2 | Olga | `Ag4w6NukSTypq08HkaIw0E9W06BwQ0pJBbjy60a5wGk=` (hex `020e30e8…b9c069`) | **NOT FOUND** | — | **UNDETERMINABLE** |
| 3 | Lena | `ZnrmAbEpybGoyg0zBVoEedEZV0txpV6OZH9b8f+XKfI=` (hex `667ae601…f9729f2`) | **NOT FOUND** | — | **UNDETERMINABLE** |

---

## 4. Conclusion

**The blockchain creation timestamps (`utime`) for these three exact transactions are NOT
available in the existing archived/project data.** Whether each transaction was created BEFORE
or AFTER the PaymentSession start (`1790578640023` ms) is therefore **UNDETERMINABLE from the
existing data**.

---

## 5. Structural Fact — Persistence Schema Stores LT, Not utime

Even where WheelWin does persist incoming room-wallet observations, the schema
(`_persistObservation`, `server/payment/roomWallet/RoomWalletIncomingObserver.js:904–946`)
stores `lt` (TON logical time) but **never `utime`** (blockchain creation time). The project's
own persistence therefore could not have retained the blockchain timestamp for these
transactions in any case. The only historical records of `utime` are manually written forensic
tables in prior reports (e.g., s85 settlement forensics, room 96YF owner transfer), none of
which covers room 5d7V or these three transaction hashes.

---

## 6. Only Remaining Sources (NOT accessed in this task)

- The TON blockchain itself (TonCenter `getTransactions` on the room wallet address for the
  three hashes).
- The Railway volume's financial persistence records (not present in this repository).

Both are outside "existing archived/project data" and were not queried, per task constraints.

---

## 7. Changes Made

Only this report file was created:
`AI_CONTEXT/CLINE_REPORTS/2026-09-28_5d7V_blockchain_timestamp_verification.md`

- No source code modified.
- No tests modified.
- No configuration modified.
- No git commit created.
- No fix implemented.
- No Railway access; no TON blockchain query; no additional audit performed.