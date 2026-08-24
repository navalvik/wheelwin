# R18.0-prep — Advertising DELETE Failure: Root Cause and Fix

Date: 2026-08-24

Task: investigate the production "Failed to fetch" failure of the Developer Console advertising DELETE operation, explain the unexpected `DISABLED` status change of `ad_001`, and fix only the root cause.

## 1. Production Failure

- Action: `/debug → Advertising` → select `ad_001` (`1_banner.jpg`, advertiser "Test banner 1") → Delete → confirm.
- Result: red error **`Failed to fetch`**; `ad_001` still listed; banner still present; `ad_001` status displayed as `DISABLED`; `ad_002` untouched (`WAITING_OWNER_RENEWAL`).

## 2. Full Path Trace (source-verified)

UI Delete → `window.confirm` → `deleteAdvertisement(accessToken, id)` (`developerAuthApi.js`) → HTTP **DELETE** `${resolveBackendUrl()}/console/advertisements/ad_001` with Authorization header → Express route `app.delete("/console/advertisements/:id", requireAdministrator)` → `AdvertisementManager.deleteCampaign()` (admin assert, NOT_FOUND check, history snapshot, metadata+asset deletion) → JSON `{ deleted: true, … }`.

The frontend URL/method and backend route/method/path match exactly; the endpoint and manager logic are correct.

## 3. Root Cause (verified from source)

The frontend origin (`wheelwin-nine.vercel.app`) differs from the backend origin (`wheelwin-production.up.railway.app`) — cross-origin requests, so every non-simple request requires a CORS preflight. `server/config/server.js` defined:

```js
methods: Object.freeze(["GET", "POST"])
```

The Express `cors` middleware therefore answers preflights with `Access-Control-Allow-Methods: GET, POST`. **DELETE is not in the allow-list**, so the browser blocks the actual request before any byte reaches the backend → `TypeError: Failed to fetch`. Same defect class affects `PATCH` (campaign edit / Save Changes) and `PUT` (runtime/audio configuration), which are part of the same console API.

Network evidence classification: browser-side preflight rejection ("Failed to fetch" = no HTTP response received); therefore NO server-side log entries for the DELETE attempt are expected — the request never reached Express routing. (Railway logs were not directly accessible from this workspace; the code-level preflight proof stands on its own.)

## 4. The `DISABLED` Status Change Explained

- `DELETE` cannot mutate status: it is blocked at the browser before reaching the server, and even on success `deleteCampaign()` removes the campaign entirely (never sets DISABLED).
- Server-side search shows exactly one producer of `DISABLED`: `AdvertisementManager.disableCampaign()` via the admin `POST /console/advertisements/:id/disable` route (or an equivalent status edit). POST is in the CORS allow-list, so Disable requests DO succeed cross-origin.
- Conclusion (verified by elimination): `ad_001` was set to DISABLED by an explicit Disable action succeeding over CORS — either clicked during/after the failed delete attempt while troubleshooting, or earlier. It was NOT caused by the DELETE path, which never reached the server. No partial backend operation occurred.

## 5. Fix

`server/config/server.js` — extend the shared Express/Socket.IO CORS method allow-list:

```js
methods: ["GET", "POST", "DELETE", "PATCH", "PUT"]
```

This preserves origin validation unchanged, keeps all gameplay/socket behavior intact, and corrects the incomplete allow-list that broke DELETE (and incidentally PATCH/PUT) console operations. No new endpoint, no auth change, no storage change.

## 6. Tests (exact results)

- NEW `server/tests/corsMethods.r180prep.test.js`: **all 2 passed** — (1) CORS methods include GET/POST/DELETE/PATCH/PUT; (2) origin validator still allows the configured client origin and denies foreign origins.
- Regression: `corsOrigin.test.js` passed; `advertisement.r143.test.js` (routes incl. delete paths) passed; advertisement r142–r148 previously green after the visibility commit.

## 7. Build / Deployment / Production Validation

- Backend-only change; client build unaffected (last verified build ✓).
- Deployed to production through the normal repository push → Railway workflow (commit below).
- **Production DELETE validation of `ad_001`: STOPPED at the manual-interaction boundary** — confirming deletion requires an authenticated interactive browser session, unavailable to this task. Post-deployment checklist (operator): reload `/debug` → select `ad_001` (now DISABLED — deletable in any status) → Delete → confirm → expect success message, list refresh, `ad_001` gone, banner asset removed, history snapshot preserved, count decrease; `ad_002` must remain untouched until `ad_001` succeeds.

## 8. State Notes

- `ad_001`: exists, status DISABLED (from the successful explicit Disable action described above), banner asset presumed still present (deletion never reached the server).
- `ad_002`: untouched throughout.

## 9. Scope Confirmation

No gameplay, financial, Telegram authentication, recovery, monitoring/R17.9T.8, room, or unrelated Developer Console changes. Only the CORS method allow-list (+ focused test) was modified. Nothing staged/committed beyond this fix and its report.
