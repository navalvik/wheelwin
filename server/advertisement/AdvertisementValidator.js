/**
 * R14.2 — AdvertisementValidator.
 * Format / size / filename / URL / quota checks only. No I/O side effects.
 */

import { basename } from "node:path";

import {
    ADVERTISEMENT_FILENAME_PATTERN,
    ADVERTISEMENT_LIMITS,
    ALLOWED_IMAGE_EXTENSIONS,
    FORBIDDEN_URL_SCHEMES
} from "./advertisementTypes.js";

export class AdvertisementValidationError extends Error {

    constructor(code, message) {

        super(message);

        this.name = "AdvertisementValidationError";
        this.code = code;

    }

}

/**
 * Sanitize a client-supplied filename.
 * Returns basename-only, path-safe name or throws.
 */
export function sanitizeAdvertisementFilename(rawFilename) {

    if (typeof rawFilename !== "string" || rawFilename.trim() === "") {

        throw new AdvertisementValidationError(
            "INVALID_FILENAME",
            "Filename is required"
        );

    }

    const trimmed = rawFilename.trim();

    if (
        trimmed.includes("\0")
        || trimmed.includes("..")
        || /[/\\]/.test(trimmed)
    ) {

        throw new AdvertisementValidationError(
            "PATH_TRAVERSAL",
            "Filename must not contain path separators or traversal"
        );

    }

    const name = basename(trimmed);

    if (name !== trimmed || name === "." || name === "..") {

        throw new AdvertisementValidationError(
            "PATH_TRAVERSAL",
            "Filename must be a simple basename"
        );

    }

    const match = name.match(ADVERTISEMENT_FILENAME_PATTERN);

    if (!match) {

        throw new AdvertisementValidationError(
            "INVALID_FILENAME",
            "Filename must match {priority}_{slug}.{jpg|jpeg|png|webp|gif}"
        );

    }

    const priority = Number.parseInt(match[1], 10);
    const slug = match[2];
    const extension = match[3].toLowerCase();

    if (!Number.isFinite(priority) || priority < 0) {

        throw new AdvertisementValidationError(
            "INVALID_PRIORITY",
            "Filename priority must be a non-negative integer"
        );

    }

    if (!ALLOWED_IMAGE_EXTENSIONS.includes(extension)) {

        throw new AdvertisementValidationError(
            "INVALID_EXTENSION",
            `Unsupported extension: ${extension}`
        );

    }

    const sanitized = `${priority}_${slug}.${extension}`;

    return {
        filename: sanitized,
        priority,
        slug,
        extension
    };

}

export function validateAdvertisementFileBuffer({
    filename,
    bytes,
    currentTotalBytes = 0
}) {

    const sanitized = sanitizeAdvertisementFilename(filename);

    if (!Buffer.isBuffer(bytes)) {

        throw new AdvertisementValidationError(
            "INVALID_BUFFER",
            "File bytes must be a Buffer"
        );

    }

    const size = bytes.byteLength;

    if (size <= 0) {

        throw new AdvertisementValidationError(
            "EMPTY_FILE",
            "File is empty"
        );

    }

    if (sanitized.extension === "gif") {

        if (size > ADVERTISEMENT_LIMITS.MAX_GIF_BYTES) {

            throw new AdvertisementValidationError(
                "GIF_TOO_LARGE",
                `GIF exceeds ${ADVERTISEMENT_LIMITS.MAX_GIF_BYTES} bytes`
            );

        }

    } else if (size > ADVERTISEMENT_LIMITS.MAX_STATIC_BYTES) {

        throw new AdvertisementValidationError(
            "FILE_TOO_LARGE",
            `Image exceeds ${ADVERTISEMENT_LIMITS.MAX_STATIC_BYTES} bytes`
        );

    }

    const totalAfter = Number(currentTotalBytes) + size;

    if (totalAfter > ADVERTISEMENT_LIMITS.TOTAL_STORAGE_BYTES) {

        throw new AdvertisementValidationError(
            "STORAGE_QUOTA_EXCEEDED",
            `Total advertisement storage exceeds ${ADVERTISEMENT_LIMITS.TOTAL_STORAGE_BYTES} bytes`
        );

    }

    return {
        ...sanitized,
        sizeBytes: size,
        recommendedStatic: size <= ADVERTISEMENT_LIMITS.RECOMMENDED_STATIC_BYTES
    };

}

/**
 * Validate destination URL. Empty string is allowed (no destination yet).
 */
export function validateDestinationUrl(rawUrl) {

    if (rawUrl == null || String(rawUrl).trim() === "") {

        return "";

    }

    const url = String(rawUrl).trim();
    const lower = url.toLowerCase();

    for (const scheme of FORBIDDEN_URL_SCHEMES) {

        if (lower.startsWith(scheme)) {

            throw new AdvertisementValidationError(
                "DANGEROUS_URL_SCHEME",
                `URL scheme is not allowed: ${scheme}`
            );

        }

    }

    let parsed;

    try {

        parsed = new URL(url);

    } catch {

        throw new AdvertisementValidationError(
            "INVALID_URL",
            "Destination URL is not a valid absolute URL"
        );

    }

    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== "https:" && protocol !== "http:") {

        throw new AdvertisementValidationError(
            "INVALID_URL_PROTOCOL",
            "Destination URL must use http: or https:"
        );

    }

    return url;

}

export class AdvertisementValidator {

    sanitizeFilename(rawFilename) {

        return sanitizeAdvertisementFilename(rawFilename);

    }

    validateFile({ filename, bytes, currentTotalBytes = 0 }) {

        return validateAdvertisementFileBuffer({
            filename,
            bytes,
            currentTotalBytes
        });

    }

    validateDestinationUrl(rawUrl) {

        return validateDestinationUrl(rawUrl);

    }

}
