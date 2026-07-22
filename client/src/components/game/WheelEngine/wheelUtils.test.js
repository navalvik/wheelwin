import {
    resolvePlayerIconFromWheel,
    resolveWheelIcon
} from "./wheelUtils.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{
    assert(
        resolveWheelIcon("frog") === "🐸",
        "catalog icon id resolves to glyph"
    );

    assert(
        resolveWheelIcon("FROG") === "🐸",
        "icon id lookup is case-insensitive"
    );

    assert(
        resolveWheelIcon("🐸") === "🐸",
        "raw glyph passes through when not a catalog id"
    );

    const sectors = [
        { ownerId: "p1", icon: "frog" },
        { ownerId: "p1", icon: "frog" },
        { ownerId: "p2", icon: "dolphin" }
    ];

    assert(
        resolvePlayerIconFromWheel(sectors, "p1") === "🐸",
        "player icon comes from first owned sector"
    );

    assert(
        resolvePlayerIconFromWheel(sectors, "p2") === "🐬",
        "player icon resolves per ownerId sector"
    );

    assert(
        resolvePlayerIconFromWheel(sectors, "missing") === null,
        "unknown player returns null"
    );

    console.log("wheelUtils.test.js — all assertions passed");

}
