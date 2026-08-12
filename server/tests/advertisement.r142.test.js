/**
 * R14.2 — Advertisement data model / storage / validator tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AdvertisementManager,
    AdvertisementValidationError
} from "../advertisement/AdvertisementManager.js";
import {
    sanitizeAdvertisementFilename,
    validateAdvertisementFileBuffer,
    validateDestinationUrl
} from "../advertisement/AdvertisementValidator.js";
import { ADVERTISEMENT_LIMITS } from "../advertisement/advertisementTypes.js";

function createManager() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-ads-"));
    const manager = new AdvertisementManager({ dataDir });

    manager.initialize();

    return { manager, dataDir };

}

function tinyJpeg() {

    // Minimal valid-looking buffer for size tests (content not decoded).
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);

}

{

    const sanitized = sanitizeAdvertisementFilename("1_banner.GIF");

    assert.equal(sanitized.filename, "1_banner.gif");
    assert.equal(sanitized.priority, 1);
    assert.equal(sanitized.extension, "gif");
    console.log("  filename sanitization normalizes extension");

}

{

    assert.throws(
        () => sanitizeAdvertisementFilename("../etc/passwd.jpg"),
        (error) => error instanceof AdvertisementValidationError
            && error.code === "PATH_TRAVERSAL"
    );

    assert.throws(
        () => sanitizeAdvertisementFilename("ads/1_banner.jpg"),
        (error) => error instanceof AdvertisementValidationError
            && error.code === "PATH_TRAVERSAL"
    );

    assert.throws(
        () => sanitizeAdvertisementFilename("banner.jpg"),
        (error) => error instanceof AdvertisementValidationError
            && error.code === "INVALID_FILENAME"
    );

    console.log("  path traversal and invalid filename rejected");

}

{

    assert.throws(
        () => sanitizeAdvertisementFilename("1_banner.mp4"),
        (error) => error instanceof AdvertisementValidationError
            && error.code === "INVALID_FILENAME"
    );

    assert.throws(
        () => validateAdvertisementFileBuffer({
            filename: "1_clip.webm",
            bytes: Buffer.alloc(10)
        }),
        (error) => error instanceof AdvertisementValidationError
    );

    console.log("  invalid extension rejected");

}

{

    const ok = validateAdvertisementFileBuffer({
        filename: "2_partner.jpg",
        bytes: tinyJpeg(),
        currentTotalBytes: 0
    });

    assert.equal(ok.filename, "2_partner.jpg");
    assert.equal(ok.extension, "jpg");
    console.log("  valid JPG validation passes");

}

{

    const gif = Buffer.alloc(1000, 1);

    const ok = validateAdvertisementFileBuffer({
        filename: "1_banner.gif",
        bytes: gif,
        currentTotalBytes: 0
    });

    assert.equal(ok.extension, "gif");
    console.log("  valid GIF validation passes");

}

{

    const oversizedGif = Buffer.alloc(ADVERTISEMENT_LIMITS.MAX_GIF_BYTES + 1, 2);

    assert.throws(
        () => validateAdvertisementFileBuffer({
            filename: "1_big.gif",
            bytes: oversizedGif,
            currentTotalBytes: 0
        }),
        (error) => error instanceof AdvertisementValidationError
            && error.code === "GIF_TOO_LARGE"
    );

    console.log("  oversized GIF rejected");

}

{

    const bytes = Buffer.alloc(1000, 3);

    assert.throws(
        () => validateAdvertisementFileBuffer({
            filename: "1_overflow.jpg",
            bytes,
            currentTotalBytes: ADVERTISEMENT_LIMITS.TOTAL_STORAGE_BYTES - 10
        }),
        (error) => error instanceof AdvertisementValidationError
            && error.code === "STORAGE_QUOTA_EXCEEDED"
    );

    console.log("  storage quota rejection works");

}

{

    assert.equal(
        validateDestinationUrl("https://t.me/example_bot"),
        "https://t.me/example_bot"
    );

    assert.equal(
        validateDestinationUrl("http://example.com"),
        "http://example.com"
    );

    assert.throws(
        () => validateDestinationUrl("javascript:alert(1)"),
        (error) => error.code === "DANGEROUS_URL_SCHEME"
    );

    assert.throws(
        () => validateDestinationUrl("data:text/html,hi"),
        (error) => error.code === "DANGEROUS_URL_SCHEME"
    );

    assert.throws(
        () => validateDestinationUrl("file:///etc/passwd"),
        (error) => error.code === "DANGEROUS_URL_SCHEME"
    );

    console.log("  destination URL validation works");

}

{

    const { manager, dataDir } = createManager();

    try {

        const created = manager.createCampaign({
            filename: "1_banner.gif",
            bytes: Buffer.alloc(64, 9),
            advertiserName: "Demo",
            destinationUrl: "https://example.com",
            role: "Administrator",
            createdBy: "Administrator"
        });

        assert.equal(created.id, "ad_001");
        assert.equal(created.filename, "1_banner.gif");
        assert.equal(created.priority, 1);
        assert.equal(created.status, "ACTIVE");
        assert.equal(created.clickCount, 0);
        assert.equal(created.impressionCount, 0);

        const listed = manager.getCampaigns({ role: "Viewer" });

        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, "ad_001");

        const loaded = manager.getCampaignById("ad_001", { role: "Viewer" });

        assert.equal(loaded.advertiserName, "Demo");
        assert.equal(loaded.destinationUrl, "https://example.com");

        const updated = manager.updateCampaign(
            "ad_001",
            { priority: 5, destinationUrl: "https://t.me/group" },
            { role: "Administrator" }
        );

        assert.equal(updated.priority, 5);
        assert.equal(updated.destinationUrl, "https://t.me/group");

        const disabled = manager.disableCampaign("ad_001", {
            role: "Administrator"
        });

        assert.equal(disabled.status, "DISABLED");

        assert.throws(
            () => manager.createCampaign({
                filename: "2_x.jpg",
                bytes: tinyJpeg(),
                role: "Viewer"
            }),
            (error) => error.code === "FORBIDDEN"
        );

        const usage = manager.getStorageUsage({ role: "Viewer" });

        assert.equal(usage.usedBytes, 64);

        manager.deleteCampaign("ad_001", { role: "Administrator" });

        assert.equal(manager.getCampaigns({ role: "Viewer" }).length, 0);
        assert.equal(manager.getStorageUsage({ role: "Viewer" }).usedBytes, 0);

        console.log("  metadata save/load/update/disable/delete works");

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

}

console.log("advertisement.r142.test.js: all assertions passed");
