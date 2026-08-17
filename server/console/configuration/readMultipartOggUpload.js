/**
 * R17.9J.2B — Minimal multipart/form-data reader for a single file field.
 * No third-party upload storage. Never throws into Express uncaught.
 */

/**
 * @param {import("http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxBytes) {

    return new Promise((resolve, reject) => {

        const chunks = [];
        let size = 0;
        let settled = false;

        const fail = (error) => {

            if (settled) {

                return;

            }

            settled = true;
            reject(error);

        };

        const succeed = (buffer) => {

            if (settled) {

                return;

            }

            settled = true;
            resolve(buffer);

        };

        req.on("data", (chunk) => {

            size += chunk.length;

            if (size > maxBytes) {

                fail(Object.assign(new Error("Upload too large"), {
                    status: 413
                }));
                req.destroy();

                return;

            }

            chunks.push(chunk);

        });

        req.on("end", () => {

            succeed(Buffer.concat(chunks));

        });

        req.on("error", (error) => {

            fail(error);

        });

    });

}

/**
 * @param {string} contentType
 * @returns {string|null}
 */
function extractBoundary(contentType) {

    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(
        String(contentType ?? "")
    );

    if (!match) {

        return null;

    }

    return (match[1] || match[2] || "").trim() || null;

}

/**
 * Parse a single multipart part header block.
 * @param {string} headerText
 */
function parsePartHeaders(headerText) {

    const headers = {};
    const lines = headerText.split(/\r\n/);

    for (const line of lines) {

        const idx = line.indexOf(":");

        if (idx <= 0) {

            continue;

        }

        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();

        headers[key] = value;

    }

    const disposition = headers["content-disposition"] || "";
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    const fileMatch = /filename="([^"]*)"/i.exec(disposition);

    return {
        name: nameMatch?.[1] ?? null,
        filename: fileMatch ? fileMatch[1] : null,
        contentType: headers["content-type"] || null
    };

}

/**
 * @param {import("http").IncomingMessage} req
 * @param {{
 *   fieldName?: string,
 *   maxBytes?: number
 * }} [options]
 * @returns {Promise<{
 *   ok: true,
 *   filename: string|null,
 *   buffer: Buffer
 * } | {
 *   ok: false,
 *   status: number,
 *   error: string
 * }>}
 */
export async function readMultipartOggUpload(req, {
    fieldName = "file",
    maxBytes = 2 * 1024 * 1024
} = {}) {

    try {

        const contentType = req.headers["content-type"] || "";

        if (!String(contentType).toLowerCase().includes("multipart/form-data")) {

            return {
                ok: false,
                status: 415,
                error: "Expected multipart/form-data upload"
            };

        }

        const boundary = extractBoundary(contentType);

        if (!boundary) {

            return {
                ok: false,
                status: 400,
                error: "Missing multipart boundary"
            };

        }

        // Allow multipart framing overhead above the file max.
        const body = await readRawBody(req, maxBytes + 64 * 1024);
        const needle = Buffer.from(`--${boundary}`);
        const parts = [];
        let start = body.indexOf(needle);

        while (start !== -1) {

            const afterBoundary = start + needle.length;

            if (body[afterBoundary] === 0x2d && body[afterBoundary + 1] === 0x2d) {

                break;

            }

            let contentStart = afterBoundary;

            if (body[contentStart] === 0x0d && body[contentStart + 1] === 0x0a) {

                contentStart += 2;

            }

            const next = body.indexOf(needle, contentStart);

            if (next === -1) {

                break;

            }

            let partEnd = next;

            if (partEnd >= 2
                && body[partEnd - 2] === 0x0d
                && body[partEnd - 1] === 0x0a) {

                partEnd -= 2;

            }

            parts.push(body.subarray(contentStart, partEnd));
            start = next;

        }

        for (const part of parts) {

            const sep = Buffer.from("\r\n\r\n");
            const headerEnd = part.indexOf(sep);

            if (headerEnd === -1) {

                continue;

            }

            const headerText = part.subarray(0, headerEnd).toString("utf8");
            const meta = parsePartHeaders(headerText);

            if (meta.name !== fieldName) {

                continue;

            }

            const fileBuffer = Buffer.from(part.subarray(headerEnd + sep.length));

            if (fileBuffer.length > maxBytes) {

                return {
                    ok: false,
                    status: 413,
                    error: `File exceeds ${maxBytes} byte limit`
                };

            }

            return {
                ok: true,
                filename: meta.filename || null,
                buffer: fileBuffer
            };

        }

        return {
            ok: false,
            status: 400,
            error: `Missing multipart field "${fieldName}"`
        };

    } catch (error) {

        return {
            ok: false,
            status: error?.status === 413 ? 413 : 400,
            error: error?.message || "Failed to read upload"
        };

    }

}
