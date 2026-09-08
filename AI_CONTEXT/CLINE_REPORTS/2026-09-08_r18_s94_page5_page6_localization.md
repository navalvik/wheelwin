# Page5 / Page6 staged localization pass

Date: 2026-09-08  
Scope: Player-facing static UI on Page5 (gameplay) and Page6 (result) only.  
No push. Page4, lobby, matrix, recovery, backend, Telegram language detection, and Page1–3 source files were not part of this commit.

---

## 1. Exact files changed (this pass / commit)

- `client/src/i18n/translations.js`
- `client/src/i18n/language.i18n.test.js`
- `client/src/pages/Page6Result.jsx`
- `client/src/components/page5/Page5ResultOverlay.jsx`
- `client/src/components/page5/ReadyPlayerPanel.jsx`
- `client/src/components/page5/PreGameReadyPlayerPanel.jsx`
- `client/src/components/game/CentralButton/CentralButtonView.jsx`
- `client/src/game/centralButton/ButtonState.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-08_r18_s94_page5_page6_localization.md` (this report)

`translations.js` / `language.i18n.test.js` also still contain the prior uncommitted Page1 key `common.bannerAlt` (same catalog files). `Banner.jsx`, `InfoMenu.jsx`, `Page3VerifyPlayers.jsx`, and locale markdown were **not** staged.

---

## 2. Page5 components audited

- `Page5Game.jsx` (headers already `game.youMustWin` / `game.youWin` / `game.youLost`)
- `Page5PlayerPanel.jsx`
- `PlayerPanel.jsx` / `PlayerPanelView.jsx` / `PlayerCard.jsx` (nicknames/icons only)
- `ReadyPlayerPanel.jsx`
- `PreGameReadyPlayerPanel.jsx`
- `Page5ResultOverlay.jsx`
- `WheelPlaceholder.jsx` / `CenterButton.jsx` / `CentralButtonView.jsx` / `ButtonState.js`
- `GameLayout` / `HeaderBar` / `InfoBar` (phase labels already `infobar.phase.*`; `PHASE_LABELS` not modified)
- `Page5DevDebugPanel.jsx` (developer-only; not localized)
- `BottomInfo.jsx` (not mounted by Page5)

---

## 3. Page6 components audited

- `Page6Result.jsx`
- `personalizedResultPresentation.js` (already exposes `headlineKey`; overlay/Page6 use `t(headlineKey)`)
- `gameReportDownload.js` — see section 10
- `GameLayout` / `HeaderBar` (FINISH already `common.finish`)

---

## 4. Existing keys reused

- `game.youMustWin`, `game.youWin`, `game.youLost`, `game.waitingResult`
- `page.result.title`, `common.finish`
- `result.gameSummary`, `result.winningSector`, `result.winningColor`, `result.winnerPayout`, `result.youReceived`
- `result.awaitingSettlement`, `result.settlementInProgress`, `result.paymentCompleted`, `result.paymentFailed`
- `result.auditPending`, `result.auditCompleted`, `result.auditUnavailable`
- `result.gameReport`, `result.downloadTxt`, `result.awaitingReport`, `result.waitingAuthoritative`
- `result.zeroGrm` (loser / invalid-amount **label**, not a dynamic amount)
- `result.recoveryInformation`, `result.playAgain`, `result.roomReturn` (aria-hidden reserved slots)
- `infobar.roomId`, `infobar.players`, `infobar.phase.*` (InfoBar on gameplay)

---

## 5–6. New keys (all five locales)

| Key | en | es | pt | fr | zh |
|-----|----|----|----|----|-----|
| `game.buttonPush` | PUSH | PULSA | APERTE | APPUYEZ | 按下 |
| `game.buttonReady` | READY | LISTO | PRONTO | PRÊT | 就绪 |
| `game.buttonCountdown` | COUNTDOWN | CUENTA ATRÁS | CONTAGEM | COMPTE À REBOURS | 倒计时 |
| `game.buttonSpin` | SPIN | GIRA | GIRAR | TOURNEZ | 旋转 |
| `game.buttonWin` | WIN | GANA | VENCEU | GAGNÉ | 胜 |
| `game.buttonLost` | LOST | PIERDE | PERDEU | PERDU | 负 |
| `game.playerReady` | ✓ READY | ✓ LISTO | ✓ PRONTO | ✓ PRÊT | ✓ 就绪 |
| `game.playerWaiting` | WAITING | ESPERANDO | AGUARDANDO | EN ATTENTE | 等待中 |
| `game.sectorSingular` | {count} sector | {count} sector | {count} setor | {count} secteur | {count} 个扇区 |
| `game.sectorPlural` | {count} sectors | {count} sectores | {count} setores | {count} secteurs | {count} 个扇区 |

Catalog size: **181** keys, identical sets.

---

## 7. Static strings localized

- Page5 result overlay headline via `t(headlineKey)` (was English `presentation.headline`)
- Center button labels PUSH / READY / COUNTDOWN / SPIN / WIN / LOST
- Pre-game card ✓ READY / WAITING
- Ready-phase “N sector(s)” via interpolated keys
- Page6 you-received amount path (see §9)

---

## 8. Dynamic / player / game values left untouched

- Nicknames, player IDs, icons, color swatches, sector counts as numbers (only the unit word is localized)
- Winning sector id / index (`#n`), winning color name from report
- Payout/amount strings (`x.xx GRM`), room IDs, timers
- Wallet addresses, transaction/report IDs
- `payment.status` / `audit.status` protocol fallbacks
- DEV-only `payment.reason`
- `personalizedResultPresentation.headline` English strings (tests still assert them; UI uses `headlineKey`)

---

## 9. Page6 payout rendering correction

Previously: `youReceived.includes(".") ? t(youReceived) : youReceived` could call `t("1.23 GRM")`.

Now: `resolveYouReceived` returns `{ mode: "amount", text }` or `{ mode: "key", key }` or `{ mode: "fallback" }`.  
`renderYouReceivedAmount` displays `text` as data, or `t(key)` only for real keys (`result.zeroGrm` / settlement status keys).

Financial calculation and settlement logic were not changed.

---

## 10. Game report decision

Page6 `Download TXT` calls `downloadGameReportNative(report, "txt")`, which opens  
`/api/game-report/:id/download?format=txt` on the **server**.

Client `formatGameReportAsText` is documented as server-parity / tests and is **not** used for the player download.

**Decision:** leave client and server TXT label format unchanged. Backend localization is out of this task. The player-facing **button/title** on Page6 remain catalog keys (`result.gameReport`, `result.downloadTxt`).

---

## 11. Remaining English on Page5/Page6 trees

| Item | Classification |
|------|----------------|
| `Page5DevDebugPanel` “Debug Panel” etc. | Developer-only |
| `BottomInfo` mock `ABCD1234` / `09:00` | Not mounted; leftover mock |
| `PHASE_LABELS` in `gameClockView.js` | Fallback only; InfoBar uses `infobar.phase.*` keys |
| Winning color names (`Green`, …) | Dynamic game data |
| `JUMP` HeaderBar | Developer-only |
| Server TXT report labels | Fixed-format export via HTTP; out of frontend scope |
| `presentation.headline` English in helper | Internal/test; UI uses keys |
| Empty center-button BRAKE/LOCKED labels | Intentional blank, not copy |

---

## 12. Test results

- `node --test client/src/i18n/language.i18n.test.js` → **5/5 pass**
- `personalizedResultPresentation.test.js` → pass (unchanged English `headline` assertions)

Language switching: `t()` is bound to `LanguageProvider`; Page5/Page6 consumers re-render on `languageCode` change. Live Mini App visual pass was not run.

---

## 13. Lint / type / build

Full Vite build not run. ESLint not re-run on all files in this pass (prior Page3 `set-state-in-effect` issues remain pre-existing and out of scope).

---

## 14. Catalog parity

Five locales, **181** matching keys (`language.i18n.test.js`).

---

## 15. Git diff scope

Staged only the files in §1. Explicitly **not** staged: `Page4Payment.jsx`, audio oggs, Page1–3 UI files, docs locales, `.vscode`, probe scripts.

---

## 16. Commit

See final response after `git commit`.

---

## 17. Push

No `git push` was performed.

---

## 18. Secrets

No secrets, mnemonics, credentials, or private configuration values were included.
