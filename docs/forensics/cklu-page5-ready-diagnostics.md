# CkLU Page5 / READY diagnostic implementation plan (Testnet only)

Baseline: `main` merge `e1f37067f4f425f0b70a99ea73f2fcdfb87601f4`.
Evidence: 2026-11-01 room CkLU, game `game_e61313c8-474c-40b3-bed4-186f64c87546`, single completed forensic ZIP.

## Verified code findings

- `client/src/game/centralButton/ButtonState.js`: `GAME_STATES.PRE_GAME_READY` maps to interactive `BUTTON_STATES.PRE_GAME_READY`; `GAME_STATES.READY` and `SELF_TEST` map to noninteractive `BUTTON_STATES.READY`. Do **not** make READY interactive as a shortcut.
- `client/src/pages/Page5Game.jsx`: `isPreGameReadyPhase` gates the confirmation handler, while `buttonInputDisabled` separately gates input. Verify the authoritative state and local confirmation at the exact time of the tap.
- `client/src/context/PreGameReadyContext.jsx`: updates overwrite `readyPlayers`, and completed event clears state. Instrument STARTED / UPDATED / COMPLETED / restore with sequence, active game and reason.
- `client/src/context/GameClockContext.jsx`: `GAME_CLOCK_UPDATE` and recovery snapshots enter `reduceGameClockUpdate`. Record accepted/rejected updates and observed render phase separately.
- `client/src/game/centralButton/CentralButtonEngine.js`: `confirmPreGameReady()` rejects when state is not PRE_GAME_READY or already confirmed. Capture the exact rejection reason; never log wallet secrets.
- `server/forensic/ForensicArchiveCollector.js`: `_discoverArtifactEntries` builds entries in the existing single ZIP. Any added gameplay diagnostics must be an **entry of the existing archive**, not a second ZIP or local retained archive.

## Required bounded telemetry

Add `forensics/client-gameplay-sync.json` to the **existing** single ZIP with `schemaVersion`, `roomId`, `gameId`, and per-player ordered events. Record on transitions/anomalies only, plus at most one lightweight sample per second while Page5 is mounted:

- Client build, Android/Telegram/WebView version (coarse versions only; no identifying device fingerprint), connection state, reconnect and recovery.
- Event: server receive timestamp, client receive timestamp, client monotonic receive time, event kind, server phase, gameId, snapshot sequence if available; acceptance/rejection and reason.
- Applied phase, displayed phase, game-clock label/value, phase remaining time, wheel and pointer angles as *displayed* (not physics engine mutation), delayed-render indication.
- PRE_GAME_READY started/updated/completed; local button state, enabled/locked, handler invoked, confirmation sent, acknowledged/rejected with reason; no synthetic READY.
- Page5 mounted/unmounted; OPEN_PAGE6 received; Page6 actually rendered; exceptions and visibility/page freeze-resume.
- Bound payload size, event count, and per-room retention; send on reconnect; drop samples before transition/error events; use existing authenticated room/game binding; redact tokens, Telegram identifiers, wallet addresses, payment data.
- Handle late diagnostics after room closure with bounded finalization policy. Never overwrite or generate a second ZIP. Report late-event counts if data cannot enter finalized ZIP.

## Test acceptance

1. Three independent clients, delayed/out-of-order/dropped snapshots, offline/resume, and Page6 already opened: all retain authoritative terminal phase; no replay of stale spin.
2. READY: valid tap in PRE_GAME_READY records attempt and acknowledgment; tap in READY or SELF_TEST is correctly disabled and logged as such; automatic timeout still advances.
3. Simulated Olga-style delayed render: show receive vs apply vs display timestamps, without relying on wall-clock synchronization across devices.
4. ZIP: exactly one archive, new entry valid JSON, bounded volume, redacted identifiers; no financial files changed.
5. Testnet only; do not modify game physics, phase durations, payment code, Mainnet, or deploy without passing checks.

## Open investigation

CkLU's completed session history already contains `developerLog` client diagnostics. Correlate those logs with the actual Page5 READY gate and clock reducer. The archive alone does not prove whether Olga's lag was network transport, event application, or UI rendering. Preserve this uncertainty until new telemetry is tested.
