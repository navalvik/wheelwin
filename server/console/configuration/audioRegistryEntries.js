/**
 * R17.9I.4 — Static Audio Registry defaults (presentation-only).
 *
 * Paths are relative to client/src/assets/audio/.
 * Missing files are expected placeholders — never block gameplay.
 */

/**
 * @typedef {{
 *   id: string,
 *   file: string,
 *   category: string,
 *   enabled: boolean,
 *   loop: boolean
 * }} AudioRegistryEntryDef
 */

/** @type {ReadonlyArray<Readonly<AudioRegistryEntryDef>>} */
export const INITIAL_AUDIO_REGISTRY_ENTRIES = Object.freeze([
    // wheel/
    Object.freeze({
        id: "wheel.spin",
        file: "wheel/spin_loop.ogg",
        category: "wheel",
        enabled: true,
        loop: true
    }),
    Object.freeze({
        id: "wheel.brake",
        file: "wheel/brake.ogg",
        category: "wheel",
        enabled: true,
        loop: false
    }),
    Object.freeze({
        id: "wheel.stop",
        file: "wheel/stop.ogg",
        category: "wheel",
        enabled: true,
        loop: false
    }),
    Object.freeze({
        id: "wheel.self_test",
        file: "wheel/self_test.ogg",
        category: "wheel",
        enabled: true,
        loop: false
    }),

    // ui/
    Object.freeze({
        id: "ui.button_click",
        file: "ui/button_click.ogg",
        category: "ui",
        enabled: true,
        loop: false
    }),
    Object.freeze({
        id: "ui.countdown",
        file: "ui/countdown.ogg",
        category: "ui",
        enabled: true,
        loop: false
    }),
    Object.freeze({
        id: "ui.notification",
        file: "ui/notification.ogg",
        category: "ui",
        enabled: true,
        loop: false
    }),

    // payment/
    Object.freeze({
        id: "payment.ok",
        file: "payment/payment_ok.ogg",
        category: "payment",
        enabled: true,
        loop: false
    }),
    Object.freeze({
        id: "payment.failed",
        file: "payment/payment_failed.ogg",
        category: "payment",
        enabled: true,
        loop: false
    }),

    // result/
    Object.freeze({
        id: "result.winner",
        file: "result/winner.ogg",
        category: "result",
        enabled: true,
        loop: false
    }),
    Object.freeze({
        id: "result.loser",
        file: "result/loser.ogg",
        category: "result",
        enabled: true,
        loop: false
    })
]);
