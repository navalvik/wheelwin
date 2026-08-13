/**
 * R14.4 — Advertisement sync protocol foundation.
 * Isolated from gameplay `game:message` and lobby events.
 *
 * Clients must NOT select ads or run independent rotation timers.
 * Clients may only render the server snapshot and compute remaining time
 * from startedAt + duration (or use remainingMs from the snapshot).
 */

import {
    ADVERTISEMENT_ELIGIBLE_PAGES,
    ADVERTISEMENT_SLOT_DURATION_SECONDS
} from "./advertisementTypes.js";

/** Dedicated Socket.IO channel — never reuse game:message. */
export const ADVERTISEMENT_MESSAGE_CHANNEL = "advertisement:message";

export const ADVERTISEMENT_MESSAGE_TYPES = Object.freeze({
    CURRENT_AD: "CURRENT_AD",
    CURRENT_AD_CHANGED: "CURRENT_AD_CHANGED",
    ADVERTISEMENT_CHANGED: "ADVERTISEMENT_CHANGED",
    ADVERTISEMENT_SYNC_REQUEST: "ADVERTISEMENT_SYNC_REQUEST",
    ADVERTISEMENT_SYNC_RESPONSE: "ADVERTISEMENT_SYNC_RESPONSE"
});

/** Top-level socket event aliases (same names as message types). */
export const ADVERTISEMENT_SOCKET_EVENTS = Object.freeze({
    ADVERTISEMENT_CHANGED: ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_CHANGED,
    ADVERTISEMENT_SYNC_REQUEST: ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_SYNC_REQUEST,
    ADVERTISEMENT_SYNC_RESPONSE: ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_SYNC_RESPONSE
});

/**
 * Remaining display time derived from the server clock — never from a client timer.
 */
export function calculateAdvertisementRemainingMs(
    startedAt,
    durationSeconds,
    nowMs = Date.now()
) {

    const start = Number(startedAt);
    const duration = Number(durationSeconds);

    if (!Number.isFinite(start) || !Number.isFinite(duration)) {

        return 0;

    }

    const endsAt = start + (duration * 1000);
    const remaining = endsAt - Number(nowMs);

    return remaining > 0 ? remaining : 0;

}

/**
 * Build the authoritative CURRENT_AD / change snapshot.
 */
export function buildCurrentAdSnapshot(input = {}, nowMs = Date.now()) {

    const duration = Number.isFinite(Number(input.duration))
        ? Number(input.duration)
        : ADVERTISEMENT_SLOT_DURATION_SECONDS;

    const startedAt = Number.isFinite(Number(input.startedAt))
        ? Number(input.startedAt)
        : nowMs;

    const advertisementId = input.advertisementId
        ?? input.bannerId
        ?? null;

    return Object.freeze({
        advertisementId,
        bannerId: advertisementId,
        filename: input.filename ?? null,
        destinationUrl: input.destinationUrl ?? null,
        priority: input.priority ?? null,
        startedAt,
        duration,
        remainingMs: calculateAdvertisementRemainingMs(
            startedAt,
            duration,
            nowMs
        ),
        eligiblePages: ADVERTISEMENT_ELIGIBLE_PAGES,
        // Explicit protocol rule for future clients.
        clientAuthority: Object.freeze({
            maySelectAdvertisement: false,
            mayRunIndependentTimer: false,
            mayRunIndependentRotation: false,
            mayRenderServerSnapshot: true,
            mayComputeRemainingFromSnapshot: true
        })
    });

}

export function buildAdvertisementEnvelope(type, payload = null, sentAt = Date.now()) {

    return Object.freeze({
        type,
        payload,
        sentAt
    });

}

export function buildAdvertisementChangedMessage(snapshot, sentAt = Date.now()) {

    return buildAdvertisementEnvelope(
        ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_CHANGED,
        snapshot,
        sentAt
    );

}

export function buildCurrentAdMessage(snapshot, sentAt = Date.now()) {

    return buildAdvertisementEnvelope(
        ADVERTISEMENT_MESSAGE_TYPES.CURRENT_AD,
        snapshot,
        sentAt
    );

}

export function buildAdvertisementSyncResponse(snapshot, sentAt = Date.now()) {

    return buildAdvertisementEnvelope(
        ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_SYNC_RESPONSE,
        snapshot,
        sentAt
    );

}

export function isAdvertisementEligiblePage(page) {

    return ADVERTISEMENT_ELIGIBLE_PAGES.includes(page);

}
