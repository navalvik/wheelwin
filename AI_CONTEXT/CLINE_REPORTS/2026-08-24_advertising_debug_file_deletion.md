# R18.0-prep — Advertising Debug File Deletion

Date: 2026-08-24

Task: expose a delete capability for advertising campaigns/assets in the Developer Console `/debug` Advertising panel before the R18.0 real gameplay acceptance tests. Narrowly scoped console-tooling change; no gameplay/financial/auth/recovery/R17.9T.8 behavior touched.

## 1. Problem Statement

`/debug → Advertising` allowed listing, uploading, creating, editing, disabling, and renewing campaigns — but offered no way to delete an obsolete advertising campaign/banner asset.

## 2. Existing Advertising Architecture (verified)

- Backend: `server/advertisement/*` — `AdvertisementManager` (campaign metadata + asset lifecycle over `AdvertisementStorage` / optional R2 via `advertisementR2Commands`), history service, redirect service, selection engine + scheduler.
- Console HTTP API: `server/console/registerAdvertisementRoutes.js` — list/get/upload/create/edit/disable/**renew** and **`DELETE /console/advertisements/:id` (`requireAdministrator`)**.
- Frontend: `client/src/console/panels/AdvertisingPanel.jsx` using `client/src/console/developerAuthApi.js`; role gating via `useDeveloperAuth().canManageConsole`.

## 3. Existing Delete Capability (verified)

A complete, secured server-side deletion already existed but was NOT exposed in the UI:

- Route: `app.delete("/console/advertisements/:id", requireAdministrator, …)` → `advertisementManager.deleteCampaign(id, { role, username })`.
- `AdvertisementManager.deleteCampaign()`: `assertAdministrator(role)`; loads campaign (NOT_FOUND validation); appends `CAMPAIGN_DELETED` history snapshot (history preserved); deletes campaign metadata **and** banner asset through the storage abstraction; logs `ADVERTISEMENT_DELETED`; returns `{ deleted: true, id, historyPreserved }`.
- Identifier is the existing campaign id — no client-supplied filesystem paths anywhere.
- Already covered by existing suites r142/r143/r144/r146/r147/r148 (authorization, validation, success/failure).

Decision: reuse this operation; only frontend exposure was missing. No second deletion mechanism created.

## 4. Implementation Changes (frontend only)

1. `client/src/console/developerAuthApi.js` — NEW `deleteAdvertisement(accessToken, id)` using HTTP DELETE on `/console/advertisements/:id` with the standard auth/error handling.
2. `AdvertisingPanel.jsx`:
   - import `deleteAdvertisement`;
   - `runAction` gains an optional success-message parameter (existing callers unchanged);
   - `CampaignLifecycleActions`: new **Delete** button (admin-only area, disabled while busy) with `window.confirm` identifying the exact campaign id and stating permanent removal + server-side history preservation;
   - dedicated `onDelete` flow calling `deleteAdvertisement`, showing "Campaign deleted." on success or the server error message on failure;
   - new parent callback `onCampaignDeleted` — clears the deleted selection/detail and refreshes the list.

Backend: zero changes. DataTable shared component: zero changes.

## 5. Authorization / Security Handling

- Reuses the existing `requireAdministrator` route middleware and `assertAdministrator` manager check — no weakening, no parallel auth system.
- Identifier-based (campaign id) — path traversal/arbitrary-path deletion is structurally impossible; asset paths resolve inside the storage abstraction only.
- Non-admin console users never see the Delete control (existing `canManage` gating), and even a forged request fails server-side with an authorization error.
- History snapshot retained for audit before deletion.

## 6. Confirmation UX & Success/Failure

- Confirmation: native dialog per existing panel convention ("Delete campaign <id>? … permanently removed … history snapshot preserved").
- Cancel → nothing happens.
- Success → "Campaign deleted." status message, list refreshed, deleted campaign gone, selection cleared.
- Failure (nonexistent id → NOT_FOUND 404 body; unauthorized → 403; storage/server error) → existing-style error paragraph shows the server-provided message; item is not removed locally.

## 7. Tests Executed (exact results)

- NEW `client/src/console/panels/advertisingDelete.test.js`: **all 2 passed** (DELETE endpoint contract on `/console/advertisements/:id`; panel Delete wiring incl. confirm + post-delete refresh).
- Regression: `advertisement.r142/r143/r144/r146/r147/r148.test.js` — **all assertions passed** (covers delete authorization, NOT_FOUND, successful deletion incl. asset removal, listing).
- `consoleGaugeVisibility.r179t8.test.js`: all passed (console regression untouched).
- Client production build (`npm run build`): ✓ built successfully.

Known pre-existing unrelated failure remains: `game/playerUI/playerUI.productionIdentity.test.js` (documented previously; not touched). Full client suite therefore does not fully pass — reported as-is.

## 8. Manual `/debug` Validation

NOT PERFORMED YET: the fix reaches production via the normal push→deployment workflow, and panel interaction requires an authenticated browser session. Post-deployment manual checklist (non-critical test file only): file listed → Delete visible → confirmation shown → cancel = no deletion → confirm = deleted → list refreshes → other files untouched. If it is ambiguous which file is safe to delete, STOP instead of deleting production-critical assets.

## 9. Files Changed

- `client/src/console/developerAuthApi.js` (+30)
- `client/src/console/panels/AdvertisingPanel.jsx` (+65/−3 region)
- `client/src/console/panels/advertisingDelete.test.js` (NEW)
- This report (NEW)

## 10. Statements

- Gameplay, financial, Telegram authentication, room creation, recovery, and R17.9T.8 security/observability behavior were NOT changed.
- No deployment configuration or environment variables were changed.
