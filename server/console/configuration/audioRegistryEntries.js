/**
 * R17.9I.2 — Initial Audio Registry mapping (presentation-only).
 *
 * Paths are relative to client/src/assets/audio/.
 * Missing files are intentional placeholders — never block gameplay.
 */

/**
 * @typedef {{
 *   eventId: string,
 *   audioFile: string,
 *   category: string,
 *   volume: number,
 *   loop: boolean,
 *   enabled: boolean
 * }} AudioRegistryEntryDef
 */

/** @type {ReadonlyArray<Readonly<AudioRegistryEntryDef>>} */
export const INITIAL_AUDIO_REGISTRY_ENTRIES = Object.freeze([
    // Existing wheel assets
    Object.freeze({
        eventId: "WHEEL_SELF_TEST",
        audioFile: "wheel/self_test.ogg",
        category: "Game",
        volume: 0.65,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "WHEEL_SPIN_LOOP",
        audioFile: "wheel/spin_loop.ogg",
        category: "Game",
        volume: 0.3,
        loop: true,
        enabled: true
    }),
    Object.freeze({
        eventId: "WHEEL_BRAKE_LOOP",
        audioFile: "wheel/brake_loop.ogg",
        category: "Game",
        volume: 0.65,
        loop: true,
        enabled: true
    }),

    // Missing placeholders — Game / UI
    Object.freeze({
        eventId: "COUNTDOWN_3",
        audioFile: "ui/countdown_3.ogg",
        category: "UI",
        volume: 0.7,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "COUNTDOWN_2",
        audioFile: "ui/countdown_2.ogg",
        category: "UI",
        volume: 0.7,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "COUNTDOWN_1",
        audioFile: "ui/countdown_1.ogg",
        category: "UI",
        volume: 0.7,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "GAME_START",
        audioFile: "ui/game_start.ogg",
        category: "Game",
        volume: 0.7,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "WHEEL_BRAKE_START",
        audioFile: "wheel/brake_start.ogg",
        category: "Game",
        volume: 0.65,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "WHEEL_STOP",
        audioFile: "wheel/stop.ogg",
        category: "Game",
        volume: 0.7,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "PLAYER_INPUT",
        audioFile: "ui/button_click.ogg",
        category: "UI",
        volume: 0.55,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "VALID_INPUT",
        audioFile: "ui/input_valid.ogg",
        category: "Game",
        volume: 0.55,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "INVALID_INPUT",
        audioFile: "ui/input_invalid.ogg",
        category: "Game",
        volume: 0.55,
        loop: false,
        enabled: true
    }),

    // Result
    Object.freeze({
        eventId: "WINNER_DECLARED",
        audioFile: "result/winner.ogg",
        category: "Result",
        volume: 0.75,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "LOSER_RESULT",
        audioFile: "result/loser.ogg",
        category: "Result",
        volume: 0.75,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "PRIZE_CREDITED",
        audioFile: "result/prize_credited.ogg",
        category: "Result",
        volume: 0.7,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "GAME_COMPLETED",
        audioFile: "result/game_completed.ogg",
        category: "Result",
        volume: 0.65,
        loop: false,
        enabled: true
    }),

    // Payment
    Object.freeze({
        eventId: "PAYMENT_STARTED",
        audioFile: "payment/payment_started.ogg",
        category: "Payment",
        volume: 0.55,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "PAYMENT_RECEIVED",
        audioFile: "payment/payment_ok.ogg",
        category: "Payment",
        volume: 0.65,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "ALL_PAYMENTS_COMPLETED",
        audioFile: "payment/payments_complete.ogg",
        category: "Payment",
        volume: 0.65,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "PAYMENT_FAILED",
        audioFile: "payment/payment_failed.ogg",
        category: "Payment",
        volume: 0.65,
        loop: false,
        enabled: true
    }),

    // Lobby
    Object.freeze({
        eventId: "ROOM_CREATED",
        audioFile: "lobby/room_created.ogg",
        category: "Lobby",
        volume: 0.5,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "PLAYER_JOINED",
        audioFile: "lobby/player_joined.ogg",
        category: "Lobby",
        volume: 0.5,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "PLAYER_LEFT",
        audioFile: "lobby/player_left.ogg",
        category: "Lobby",
        volume: 0.45,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "ROOM_FULL",
        audioFile: "lobby/room_full.ogg",
        category: "Lobby",
        volume: 0.55,
        loop: false,
        enabled: true
    }),

    // Verification
    Object.freeze({
        eventId: "VERIFY_STARTED",
        audioFile: "verification/verify_started.ogg",
        category: "Verification",
        volume: 0.55,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "PLAYER_VERIFIED",
        audioFile: "verification/player_verified.ogg",
        category: "Verification",
        volume: 0.55,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "ALL_PLAYERS_VERIFIED",
        audioFile: "verification/all_verified.ogg",
        category: "Verification",
        volume: 0.6,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "VERIFY_TIMEOUT",
        audioFile: "verification/verify_timeout.ogg",
        category: "Verification",
        volume: 0.6,
        loop: false,
        enabled: true
    }),

    // System
    Object.freeze({
        eventId: "CONNECTION_LOST",
        audioFile: "system/connection_lost.ogg",
        category: "System",
        volume: 0.6,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "CONNECTION_RESTORED",
        audioFile: "system/connection_restored.ogg",
        category: "System",
        volume: 0.55,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "WARNING",
        audioFile: "system/warning.ogg",
        category: "System",
        volume: 0.6,
        loop: false,
        enabled: true
    }),
    Object.freeze({
        eventId: "ERROR",
        audioFile: "system/error.ogg",
        category: "System",
        volume: 0.65,
        loop: false,
        enabled: true
    })
]);
