import {
    resolvePlayerColorFromWheel,
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
        { ownerId: "p1", icon: "frog", color: "#e74c3c" },
        { ownerId: "p1", icon: "frog", color: "#e74c3c" },
        { ownerId: "p2", icon: "dolphin", color: "#3498db" }
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

    assert(
        resolvePlayerColorFromWheel(sectors, "p1") === "#e74c3c",
        "player color comes from first owned sector"
    );

    assert(
        resolvePlayerColorFromWheel(sectors, "p2") === "#3498db",
        "player color resolves per ownerId sector"
    );

    assert(
        resolvePlayerColorFromWheel(sectors, "missing") === null,
        "unknown player color returns null"
    );

    console.log("wheelUtils.test.js — all assertions passed");

}
