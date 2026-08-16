/**
 * R17.9I.5 — Client Audio Registry catalog + event → registry id map.
 *
 * Mirrors server static defaults. Runtime overrides arrive via GET /audio/registry.
 * Presentation only.
 */

/** Existing Page5 / AudioContext event ids → registry entry ids. */
export const AUDIO_EVENT_REGISTRY_IDS = Object.freeze({
    WHEEL_SELF_TEST: "wheel.self_test",
    WHEEL_SPIN_LOOP: "wheel.spin",
    WHEEL_BRAKE_LOOP: "wheel.brake",
    PLAYER_INPUT: "ui.button_click",
    WINNER_DECLARED: "result.winner",
    LOSER_RESULT: "result.loser"
});

/**
 * Fallback static catalog when /audio/registry is unavailable.
 * Status is UNKNOWN until the server snapshot or local asset probe runs.
 */
export const CLIENT_AUDIO_REGISTRY_DEFAULTS = Object.freeze([
    Object.freeze({
        id: "wheel.spin",
        file: "wheel/spin_loop.ogg",
        category: "wheel",
        enabled: true,
        loop: true,
        status: null
    }),
    Object.freeze({
        id: "wheel.brake",
        file: "wheel/brake.ogg",
        category: "wheel",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "wheel.stop",
        file: "wheel/stop.ogg",
        category: "wheel",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "wheel.self_test",
        file: "wheel/self_test.ogg",
        category: "wheel",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "ui.button_click",
        file: "ui/button_click.ogg",
        category: "ui",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "ui.countdown",
        file: "ui/countdown.ogg",
        category: "ui",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "ui.notification",
        file: "ui/notification.ogg",
        category: "ui",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "payment.ok",
        file: "payment/payment_ok.ogg",
        category: "payment",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "payment.failed",
        file: "payment/payment_failed.ogg",
        category: "payment",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "result.winner",
        file: "result/winner.ogg",
        category: "result",
        enabled: true,
        loop: false,
        status: null
    }),
    Object.freeze({
        id: "result.loser",
        file: "result/loser.ogg",
        category: "result",
        enabled: true,
        loop: false,
        status: null
    })
]);

/**
 * @param {string} eventId
 * @returns {string|null}
 */
export function mapAudioEventToRegistryId(eventId) {

    const key = String(eventId ?? "").trim();

    if (!key) {

        return null;

    }

    return AUDIO_EVENT_REGISTRY_IDS[key] ?? null;

}
