/**
 * R14.2 — Advertisement domain constants (storage / validation only).
 */

export const ADVERTISEMENT_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    DISABLED: "DISABLED",
    WAITING_OWNER_RENEWAL: "WAITING_OWNER_RENEWAL",
    ARCHIVED: "ARCHIVED"
});

export const ADVERTISEMENT_SCHEMA_VERSION = 1;

/** Bytes */
export const ADVERTISEMENT_LIMITS = Object.freeze({
    RECOMMENDED_STATIC_BYTES: 100 * 1024,
    MAX_GIF_BYTES: 300 * 1024,
    MAX_STATIC_BYTES: 300 * 1024,
    TOTAL_STORAGE_BYTES: 10 * 1024 * 1024
});

export const ALLOWED_IMAGE_EXTENSIONS = Object.freeze([
    "jpg",
    "jpeg",
    "png",
    "webp",
    "gif"
]);

export const ALLOWED_MIME_HINTS = Object.freeze({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif"
});

/**
 * {priority}_{slug}.{ext}
 * Priority is the leading integer used for initial ordering.
 */
export const ADVERTISEMENT_FILENAME_PATTERN = /^(\d+)_([A-Za-z0-9][A-Za-z0-9._-]*)\.(jpe?g|png|gif|webp)$/i;

export const FORBIDDEN_URL_SCHEMES = Object.freeze([
    "javascript:",
    "data:",
    "file:",
    "vbscript:",
    "blob:"
]);

/** R14.4 — Server-authoritative display window (seconds / ms). */
export const ADVERTISEMENT_SLOT_DURATION_SECONDS = 20;

export const ADVERTISEMENT_SLOT_DURATION_MS = ADVERTISEMENT_SLOT_DURATION_SECONDS * 1000;

/**
 * Future client pages that may render rotating ads.
 * Other pages remain WheelWin brand banner only.
 */
export const ADVERTISEMENT_ELIGIBLE_PAGES = Object.freeze([
    "WELCOME",
    "ROOM_LOBBY",
    "RESULT"
]);

export const ADVERTISEMENT_BRAND_ONLY_PAGES = Object.freeze([
    "PLAYER_SETUP",
    "MATRIX",
    "VERIFY",
    "PAYMENT",
    "GAMEPLAY"
]);

/** R14.7 — Auction preparation (metadata only; no TON / billing). */
export const ADVERTISEMENT_BID_CURRENCY = Object.freeze({
    MANUAL: "MANUAL"
});

export const ADVERTISEMENT_AUCTION_DEFAULTS = Object.freeze({
    advertiserBid: 0,
    bidCurrency: ADVERTISEMENT_BID_CURRENCY.MANUAL
});

/**
 * True when expiresAt is set and strictly before `now`.
 * Missing / invalid expiresAt means the campaign does not auto-expire.
 */
export function isAdvertisementExpired(expiresAt, now = new Date()) {

    if (expiresAt == null || expiresAt === "") {

        return false;

    }

    const expiresMs = Date.parse(String(expiresAt));

    if (!Number.isFinite(expiresMs)) {

        return false;

    }

    const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));

    if (!Number.isFinite(nowMs)) {

        return false;

    }

    return expiresMs < nowMs;

}
