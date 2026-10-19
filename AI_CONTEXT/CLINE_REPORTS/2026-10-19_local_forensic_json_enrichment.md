# WheelWin — Final Local Forensic JSON Enrichment (room `9NjK`)

Date: 2026-10-19
Type: **Offline data-processing task. No application or server behaviour was modified.**
Scope: enrich the existing local game JSON with the wallet / TON Connect information available in the
production game archive cited by
`AI_CONTEXT/CLINE_REPORTS/2026-10-19_forensic_local_json_vs_production_zip_wallet_gap.md`.

---

## 1. Exact artifacts

| Role | Path | Identity | SHA-256 |
|---|---|---|---|
| **Target JSON (source record)** | `server/data/session-history/2026-10-19_15-28-15_ROOM_9NjK_GAME_game_463cfd20-0746-4c1c-bb4c-8f50d2c7e703_ROOM_DESTROYED.json` | room `9NjK`, game `game_463cfd20-0746-4c1c-bb4c-8f50d2c7e703`, session `sess_9NjK_1792423215256`, 2026-10-19 15:20:15 → 15:28:15 | `ed8dd9532c237c9f666fef4248151341e53a57221b0189cd2e8435e5af3807d9` |
| **Source archive** | `Cloudflare-R2-Backup/forensic-archives/2026-10-07_ROOM_CEzQ_GAME_game_7c08b485-577e-4f83-a9b1-df8ebdd1346b_COMPLETED.zip` | room `CEzQ`, game `game_7c08b485-577e-4f83-a9b1-df8ebdd1346b`, session `sess_CEzQ_1791368874557`, 2026-10-07 | `3f35b436439c4b31e681a1e6641f6edbad4b67d95a47824edc6c017191ae3a5d` |
| **Enriched output (generated)** | `forensic-enrichment/2026-10-19_15-28-15_ROOM_9NjK_GAME_game_463cfd20-0746-4c1c-bb4c-8f50d2c7e703_ROOM_DESTROYED.enriched.json` | enriched copy of the target record | — (49,861 bytes) |
| Generator / validation log | `forensic-enrichment/build-enrichment.mjs`, `forensic-enrichment/enrichment-validation.json` | — | — |

The source archive was opened **read-only** (in-memory ZIP central-directory read). It was not
extracted into the repository, not re-zipped, not renamed, not moved and not uploaded; its SHA-256 is
re-verified after the run (see §5).

Archive members used (21 in total; 6 non-audit members + 16 audit records):

```
session-history/2026-10-07_10-30-51_ROOM_CEzQ_GAME_game_7c08b485-577e-4f83-a9b1-df8ebdd1346b_GAME_COMPLETED.json
ton-financial/active/payment_session/pay_a7177ecf-c664-41c0-bd40-f54f717a05f1.json
ton-financial/active/recovery_data/game_7c08b485-577e-4f83-a9b1-df8ebdd1346b.json
ton-financial/active/settlement/game_7c08b485-577e-4f83-a9b1-df8ebdd1346b.json
ton-financial/active/setup_session/CEzQ.json
ton-financial/immutable/audit/rwin__EQDNUDegzGDLTae_mbjwpb9IkcUNoPXnQpNgaZYBpO2srnRU__<tx>.json   (16 records)
```

---

## 2. Same-game check — the gate of STEP 1.5

**Result: the archive and the JSON do *not* belong to the same game.** The merge gate therefore
fails, and no wallet value from the archive was attributed to the players of game `9NjK`.

| Identity attribute | Local JSON (`9NjK`) | Archive (`CEzQ`) | Equal? |
|---|---|---|---|
| `roomId` | `9NjK` | `CEzQ` | no |
| `gameId` | `game_463cfd20-0746-4c1c-bb4c-8f50d2c7e703` | `game_7c08b485-577e-4f83-a9b1-df8ebdd1346b` | no |
| `sessionId` | `sess_9NjK_1792423215256` | `sess_CEzQ_1791368874557` | no |
| `playerId` set | `player_bdc1e8bb…`, `player_54d126da…`, `player_2878ab7e…` | `player_bfa63708…`, `player_34789c44…`, `player_a67be58c…` | no overlap |
| nicknames | Lena, Bob, Olga | Olga, Lena, Bob | same set of nicknames |

Systematic check performed by the generator: the **gameId** intersection of the **15** local
`server/data/session-history/*.json` records against the **89** production archives in
`Cloudflare-R2-Backup/forensic-archives/` is **empty (0 matches)**. The `CEzQ` archive is the
archive cited by the forensic report and is therefore the only candidate reference archive for this
task; no production archive exists for room `9NjK` or game `game_463cfd20-…`.

Consequence applied: the archive's real wallet values are carried in the enriched record under
`walletDiagnostics.referenceArchive`, with their exact source member and JSON pointer, and are
explicitly marked `"attributionToThisGame": "NONE"`. Every game-scoped wallet field of the
`9NjK` record remains `null` with an explicit status.

Local corroboration that no wallet was captured for `9NjK` in this run:

* `server/logs/games/2026-10-19_15-20-15_ROOM_9NjK_SETUP_EXPIRED.log` — **0** matches for
  `wallet` / `tonconnect` / `EQ…` / `0Q…`.
* `server/data/room-wallet-payments/testnet/refunds/closed-refund-rooms/ec674b2779beab18f32b267f1fce45d75fe76359fe6a74164975be7c0c546c6b.json`
  (room `9NjK`, closed `1792423695263`) — contains **no wallet address** (only `roomId`,
  `roomNumber`, `closureReason`, `closedAtMs`, `networkName`, `globalId`).

---

## 3. Fields added to the local JSON, and their source locations in the archive

All pre-existing fields and values of the target record are preserved **unchanged**; the fields
below are purely additive.

### 3.1 Game-scoped wallet slots (values deliberately absent — see §2)

| Added field (in `players[]` and in `finalSnapshot.players[]`) | Value in the enriched record | Archive field that would carry it |
|---|---|---|
| `walletAddress` | `null` | `session-history/…_GAME_COMPLETED.json#/players[].walletAddress` |
| `walletAddressStatus` | `NOT_ESTABLISHED_FOR_THIS_GAME` | — (status marker) |
| `sessionWalletAddress` | `null` | `session-history/…#/tonConnect/players[].sessionWallet`; `ton-financial/active/recovery_data/…#/payload/players[].wallet`; `ton-financial/active/payment_session/…#/payload/walletSessions[].walletAddress` |
| `sessionWalletAddressStatus` | `NOT_ESTABLISHED_FOR_THIS_GAME` | — |
| `onChainTransactionSenderAddress` | `null` | `ton-financial/immutable/audit/*.json#/payload/sender` |
| `onChainTransactionSenderAddressStatus` | `NOT_OBSERVED_IN_THIS_GAME` | — |

### 3.2 New top-level `walletDiagnostics`

| Added path | Content | Archive source |
|---|---|---|
| `walletDiagnostics.addressTypes.playerConnectedWalletAddress` | role, form `EQ…`, owner `player`, archive field + members, `valueForThisGame: null`, `status` | `session-history/…#/players[].walletAddress`, `#/tonConnect/players[].connectedWallet` |
| `walletDiagnostics.addressTypes.sessionWalletAddress` | role, form `0Q…`, owner `server`, archive field + members, `valueForThisGame: null`, `status` | `#/tonConnect/players[].sessionWallet`, `recovery_data#/payload/players[].wallet`, `payment_session#/payload/walletSessions[].walletAddress` |
| `walletDiagnostics.addressTypes.onChainTransactionSenderAddress` | role, owner `player (payer)`, archive field + members, `valueForThisGame: null`, `status` | `immutable/audit/*.json#/payload/sender` |
| `walletDiagnostics.addressTypes.serverControlledDestinationWalletAddress` | role, owner `server`, scope `room`, archive field + members, `valueForThisGame: null`, `status` | `immutable/audit/*.json#/payload/destination` |
| `walletDiagnostics.absentReason` | why every game-scoped wallet slot is empty | — |
| `walletDiagnostics.serverControlledDestinationWallet.roomWalletAddress` | `null` | `immutable/audit/*.json#/payload/destination` |
| `walletDiagnostics.tonConnectDiagnostics` | `handshakeStage`, `paymentConnectionReady`, `paymentSessionActive`, `hasWalletConnectionSession`, `bridge`, `ownership`, `eventCount`, `events` — all empty/`null` + `status: NOT_ESTABLISHED_FOR_THIS_GAME` | `session-history/…#/tonConnect` |
| `walletDiagnostics.walletConnectionSession` | `paymentConnectionReady`, `handshakeStage`, `players` — all empty/`null` + `status` | `session-history/…#/walletConnectionSession` |
| `walletDiagnostics.referenceArchive` | full reference evidence with per-value source pointers (see §3.3) | all archive members |

The legacy TON Connect vocabulary is **not** resurrected as a populated top-level `tonConnect` /
`walletConnectionSession` block of the local record; the archive's corresponding diagnostics live in
`walletDiagnostics.referenceArchive.*` and are labelled as belonging to game `CEzQ`.

### 3.3 `walletDiagnostics.referenceArchive` — reference evidence (belongs to game `CEzQ`)

| Path in the enriched record | Archive source location |
|---|---|
| `archivePath`, `archiveSha256`, `archiveRoomId`, `archiveGameId`, `archiveSessionId`, `archiveMembers` | ZIP metadata + member list |
| `sameGameAsThisRecord: false`, `sameGameCheck` | computed (§2) |
| `players[].playerConnectedWalletAddress` → `EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp` (Olga), `EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le` (Lena), `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` (Bob) | `session-history/…#/players/<i>/walletAddress`, `…#/tonConnect/players/<i>/connectedWallet` |
| `players[].sessionWalletAddress` → `0QDeWBnz…HyMqm`, `0QC9qwKA…laxSR`, `0QAtggW7…bypD` | `…#/tonConnect/players/<i>/sessionWallet`, `recovery_data…#/payload/players/<i>/wallet`, `payment_session…#/payload/walletSessions/<i>/walletAddress` |
| `players[].onChainTransactionSenderAddresses[]` → 10 observations (transaction hash, amount in gram, `ACCEPTED`/`REJECTED`, `rejectionReason: stale_transaction`) | `ton-financial/immutable/audit/rwin__EQDNUDegzGDLTae_…__<tx>.json#/payload/sender` |
| `players[].nicknameAlsoPresentInThisGame: true`, `playerIdAlsoPresentInThisGame: false`, `attributionToThisGame: "NONE"` | derived |
| `serverControlledDestinationWalletAddress` → `EQDNUDegzGDLTae_mbjwpb9IkcUNoPXnQpNgaZYBpO2srnRU` (room wallet of `CEzQ`) | `immutable/audit/…#/payload/destination` |
| `tonConnectDiagnostics` → `handshakeStage: "PAYMENT_READY"`, `paymentConnectionReady: true`, `paymentSessionActive: true`, `paymentSessionStatus: "FULLY_PAID"`, `hasWalletConnectionSession: true`, `bridge`, `ownership`, `eventCount: 27`, per-type event counts | `session-history/…#/tonConnect` |
| `walletConnectionSession` → `paymentConnectionReady: true`, `handshakeStage: "PAYMENT_READY"`, 3 players | `session-history/…#/walletConnectionSession` |
| `paymentSession` → `pay_a7177ecf-c664-41c0-bd40-f54f717a05f1`, `FULLY_PAID`, 3 participants, `roomWalletAddress` | `session-history/…#/payment`, `ton-financial/active/payment_session/…#/payload` |
| `settlement` → `settle_d77c5f34-…`, winner + owner wallet, settlement tx hash, status | `ton-financial/active/settlement/…#/payload` |

### 3.4 New top-level `enrichment`

Metadata: generator path, timestamp, SHA-256 of the source record and of the archive, the
same-game check, the list of added fields, and the list of unresolved fields.

---

## 4. Address-type distinction (never interchangeable)

The four address classes are carried in four distinct, separately named fields, each with its own
`role`, `ownedBy`, `addressForm` and `status`:

| Field | Class | Form | Owner |
|---|---|---|---|
| `playerConnectedWalletAddress` | wallet the player connected (payer) | `EQ…` | player |
| `sessionWalletAddress` | server-side session wallet derived from the player's wallet | `0Q…` | server |
| `onChainTransactionSenderAddress` | sender observed in an on-chain transfer | `EQ…` | player (payer of the transfer) |
| `serverControlledDestinationWalletAddress` | room wallet that receives the stake | `EQ…` | server |

No value of one class is ever written into a field of another class, and no game-scoped field of
the `9NjK` record contains any value of any class.

**Containment check (executed):** every one of the 59 occurrences of an archive wallet address in
the enriched output lies under `/walletDiagnostics/referenceArchive` — **0** occurrences outside it.

---

## 5. JSON validation results

`forensic-enrichment/enrichment-validation.json` (produced by `build-enrichment.mjs`):

| Check | Result | Detail |
|---|---|---|
| Output parses as JSON | **pass** | 49,857 characters re-parsed after writing |
| Every original field and value preserved | **pass** | no drift (deep comparison of every original key, including `players[]` and `finalSnapshot.players[]`) |
| Original top-level key order preserved | **pass** | original keys keep their positions; new blocks appended |
| Source archive unmodified | **pass** | SHA-256 `3f35b436…3a5d` identical before and after |
| Source local record unmodified | **pass** | SHA-256 `ed8dd953…07d9` identical before and after |
| Archive-derived values match the source archive | **pass** | **41** JSON pointers re-read from the ZIP and compared value-by-value |
| No wallet value invented for this game | **pass** | all game-scoped wallet fields are `null` with an explicit status |
| Four wallet address types kept distinct | **pass** | `playerConnectedWalletAddress`, `sessionWalletAddress`, `onChainTransactionSenderAddress`, `serverControlledDestinationWalletAddress` |
| Archive/record same-game relation stated explicitly | **pass** | different `roomId`, `gameId`, `sessionId`, `playerId`s |
| **All checks passed** | **pass** | `allChecksPassed: true` |

The 41 verified pointers cover every archive-derived value in the enriched record: 3 ×
(connected wallet + session wallet), 10 on-chain sender observations, the room destination wallet,
7 TON Connect diagnostic fields, 2 wallet-connection fields, 3 payment-session fields and 6
settlement fields.

---

## 6. `.gitignore` change and `git check-ignore` verification

### 6.1 Exact change

`.gitignore` (48 → 51 lines; appended only, the pre-existing user rule at lines 47–48 was preserved
byte-for-byte, CRLF endings kept):

```gitignore
# Final local forensic JSON enrichment — generated output and its storage directory
/forensic-enrichment/
```

`git diff -- .gitignore`:

```diff
@@ -43,3 +43,9 @@ server/scripts/room-wallet-provisioning/
 
 # Local Testnet Room Wallet runtime catalog (copied from offline secrets — never commit)
 server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json
+
+# R17.9T.6-E — local-development browser identity (never publish to GitHub)
+server/auth/localBrowserIdentity.js
+
+# Final local forensic JSON enrichment — generated output and its storage directory
+/forensic-enrichment/
```

The rule is root-anchored (`/forensic-enrichment/`), so it matches only the dedicated storage
directory at the repository root and everything inside it — the generated forensic JSON output, the
validation log and the generator. No pre-existing rule was duplicated; the repository had no rule
for this path before.

### 6.2 `git check-ignore -v` results

| Path | Result | Matching rule |
|---|---|---|
| `forensic-enrichment/` | **ignored** | `.gitignore:51:/forensic-enrichment/` |
| `forensic-enrichment/2026-10-19_15-28-15_ROOM_9NjK_…_ROOM_DESTROYED.enriched.json` | **ignored** | `.gitignore:51:/forensic-enrichment/` |
| `forensic-enrichment/build-enrichment.mjs` | **ignored** | `.gitignore:51:/forensic-enrichment/` |
| `forensic-enrichment/enrichment-validation.json` | **ignored** | `.gitignore:51:/forensic-enrichment/` |
| `server/data/session-history/…_ROOM_9NjK_….json` | ignored (pre-existing) | `.gitignore:25:server/data/session-history/` |
| `server/data/ton-financial/manifest.json` | ignored (pre-existing) | `.gitignore:28:server/data/ton-financial/` |
| `server/app.js` | **not ignored** | — |
| `client/src/pages/Page3VerifyPlayers.jsx` | **not ignored** | — |
| `Cloudflare-R2-Backup/forensic-archives/2026-10-07_ROOM_CEzQ_…_COMPLETED.zip` | **not ignored** | — |
| `AI_CONTEXT/CLINE_REPORTS/2026-10-19_forensic_local_json_vs_production_zip_wallet_gap.md` | **not ignored** | — |
| `forensic-investigation/valid_baseline_game_08dfc45b-….json` | **not ignored** | — |

`git status --porcelain` contains **0** entries matching `forensic-enrichment`.

---

## 7. Confirmation that no application source code was modified

* `git diff --stat` after the task: **23 files changed, 805 insertions(+), 97 deletions(-)**.
  The baseline before the task was *23 files changed, 802 insertions(+), 97 deletions(-)* — the
  delta is **exactly the 3 appended `.gitignore` lines**. The 22 application/test files
  (`client/src/**`, `server/**`) are byte-identical to the baseline; none of them was touched.
* No file under `client/src/`, `server/`, `contracts/`, `server/config/` or `server/tests/` was
  created, edited, renamed or deleted. The only files created by this task are the two new
  ignored artefacts under `forensic-enrichment/` and this report.
* `server/history/SessionHistoryArchiveManager.js`, `server/socket/RoomLobbyBridge.js`,
  `server/payment/**`, `server/engines/**`, `server/engines/gameReport/**`,
  `server/console/projectionBuilders/buildRoomDetail.js`, `server/models/NetworkMode.js` and the
  client verification page were **read only**.
* No `.env`, deployment setting, Railway/Vercel/Cloudflare configuration or remote storage was
  touched. `LIVE_PAYMENT_ACCEPTANCE_ENABLED` remains `false`; no transaction, refund, settlement or
  payment test was executed; no TON network call was made.
* No legacy financial/forensic subsystem was restored; `server/forensic/` and
  `TonFinancialPersistence` remain absent.
* Git: no `add`, `commit`, `push`, `stash`, `reset`, `clean`, `checkout`, `switch` or history
  rewrite. `HEAD` is unchanged at `860aa3bb199023577b1aa2bc591d17054ab735f9`; the index is empty
  (`git diff --cached --stat` produces no output).
* The source local record and the production ZIP were both opened read-only and their SHA-256
  digests are unchanged (§5).
* Room `SQ96` was not investigated; its local record and its closed-refund record were only
  observed in directory listings, never read as evidence.

---

## 8. Unresolved fields — not established by the archive

The archive documents a **different game**, so it establishes **no** wallet value for game `9NjK`.
The following fields remain empty with an explicit status, and are listed in the enriched record
under `enrichment.unresolvedFields`:

| Field | Value | Status | Reason |
|---|---|---|---|
| `players[].walletAddress` (×3) | `null` | `NOT_ESTABLISHED_FOR_THIS_GAME` | The reference archive documents room `CEzQ` / game `game_7c08b485-…`; the wallet was never transmitted by the client and never captured by the report builder in this run. |
| `players[].sessionWalletAddress` (×3) | `null` | `NOT_ESTABLISHED_FOR_THIS_GAME` | No TON Connect handshake occurred, so no session wallet (`0Q…`) was derived. |
| `players[].onChainTransactionSenderAddress` (×3) | `null` | `NOT_OBSERVED_IN_THIS_GAME` | No on-chain transfer exists for this game — payment acceptance is disabled and no payment session was prepared. |
| `walletDiagnostics.serverControlledDestinationWallet.roomWalletAddress` | `null` | `NOT_ESTABLISHED_FOR_THIS_GAME` | No room wallet was reserved for room `9NjK`; the local closed-refund record for `9NjK` carries no wallet address. |
| `walletDiagnostics.tonConnectDiagnostics` | empty | `NOT_ESTABLISHED_FOR_THIS_GAME` | No wallet handshake occurred in this game. |
| `walletDiagnostics.walletConnectionSession` | empty | `NOT_ESTABLISHED_FOR_THIS_GAME` | Same as above. |
| `setupSession` / `configuration.setupSession` | `null` (unchanged) | `NOT_ESTABLISHED_FOR_THIS_GAME` | Already `null` in the source record; the reference archive belongs to a different game and cannot establish it. |

**Nickname correlation is recorded but never used as a value source.** The archive's three players
carry the nicknames Olga / Lena / Bob, which also occur in the local record; the `playerId`s are
disjoint and the runs are 12 days apart. The enriched record states this explicitly
(`nicknameAlsoPresentInThisGame: true`, `playerIdAlsoPresentInThisGame: false`,
`attributionToThisGame: "NONE"`) and no address was transferred between the two games.

---

## 9. Files produced by this task

| File | Status |
|---|---|
| `forensic-enrichment/2026-10-19_15-28-15_ROOM_9NjK_GAME_game_463cfd20-0746-4c1c-bb4c-8f50d2c7e703_ROOM_DESTROYED.enriched.json` | new, git-ignored |
| `forensic-enrichment/build-enrichment.mjs` | new, git-ignored (reproducible generator) |
| `forensic-enrichment/enrichment-validation.json` | new, git-ignored (validation log) |
| `AI_CONTEXT/CLINE_REPORTS/2026-10-19_local_forensic_json_enrichment.md` | new, this report (not ignored — same convention as the other reports in this directory) |
| `.gitignore` | 3 lines appended (no existing rule changed or removed) |
