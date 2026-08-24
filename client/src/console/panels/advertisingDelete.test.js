/**
 * R18.0-prep — Advertising debug file deletion (Developer Console).
 *
 * Contract checks:
 * 1. developerAuthApi exposes deleteAdvertisement using HTTP DELETE on
 *    /console/advertisements/:id (the existing administrator-only endpoint).
 * 2. AdvertisingPanel wires a Delete control with confirmation and a
 *    post-deletion list refresh that clears the deleted selection.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const panelsDir = dirname(fileURLToPath(import.meta.url));
const consoleDir = join(panelsDir, "..");

// --- Test 1: API function uses the existing admin DELETE endpoint ------------

{

    const source = readFileSync(
        join(consoleDir, "developerAuthApi.js"),
        "utf8"
    );

    const fnStart = source.indexOf(
        "export async function deleteAdvertisement"
    );

    assert.ok(fnStart >= 0, "deleteAdvertisement must be exported");

    const fnBody = source.slice(fnStart, fnStart + 900);

    assert.ok(
        fnBody.includes("method: \"DELETE\""),
        "deleteAdvertisement must use HTTP DELETE"
    );

    assert.ok(
        fnBody.includes("/console/advertisements/${encodeURIComponent(id)}"),
        "deleteAdvertisement must target /console/advertisements/:id"
    );

    console.log("  test 1 (deleteAdvertisement DELETE endpoint) passed");

}

// --- Test 2: panel wires Delete + confirm + post-delete refresh --------------

{

    const source = readFileSync(
        join(panelsDir, "AdvertisingPanel.jsx"),
        "utf8"
    );

    assert.ok(
        source.includes("deleteAdvertisement"),
        "panel must import/use deleteAdvertisement"
    );

    assert.ok(
        source.includes("onClick={onDelete}"),
        "panel must render a Delete control"
    );

    assert.ok(
        source.includes("window.confirm"),
        "deletion must require explicit confirmation"
    );

    assert.ok(
        source.includes("\"Campaign deleted.\""),
        "successful deletion must surface success feedback"
    );

    assert.ok(
        source.includes("onCampaignDeleted"),
        "post-deletion flow must refresh and clear selection"
    );

    console.log("  test 2 (panel Delete wiring) passed");

}

console.log("advertisingDelete.test.js: all passed");
