import { createReadStream, statSync } from "node:fs";
import { PutObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * R13.9H — Upload forensic ZIP archives to a private Cloudflare R2 bucket
 * via the S3-compatible API. No public URLs are generated.
 */
export class R2ForensicArchiveUploader {

    constructor({
        logger = null,
        bucket,
        prefix = "forensic-archives",
        endpoint = "",
        accessKeyId = "",
        secretAccessKey = "",
        accountId = ""
    } = {}) {

        this._logger = logger;
        this._bucketName = String(bucket || "").trim();
        this._prefix = String(prefix || "").replace(/^\/+|\/+$/g, "");
        this._endpoint = String(endpoint || "").trim();
        this._accessKeyId = String(accessKeyId || "").trim();
        this._secretAccessKey = String(secretAccessKey || "").trim();
        this._accountId = String(accountId || "").trim();

        this._client = this._createClient();

    }

    _createClient() {

        if (!this.isConfigured()) {

            return null;

        }

        const endpoint = this._endpoint
            || (this._accountId
                ? `https://${this._accountId}.r2.cloudflarestorage.com`
                : "");

        if (!endpoint) {

            return null;

        }

        return new S3Client({
            region: "auto",
            endpoint,
            credentials: {
                accessKeyId: this._accessKeyId,
                secretAccessKey: this._secretAccessKey
            },
            forcePathStyle: true
        });

    }

    isConfigured() {

        return Boolean(
            this._bucketName
            && this._accessKeyId
            && this._secretAccessKey
            && (this._endpoint || this._accountId)
        );

    }

    /**
     * @returns {Promise<{ objectName: string, generation: string|null, etag: string|null }>}
     */
    async uploadFile(localPath, objectName, { revision = null } = {}) {

        if (!this.isConfigured() || !this._client) {

            throw new Error("R2 forensic bucket is not configured");

        }

        const destination = this._prefix
            ? `${this._prefix}/${objectName}`
            : objectName;

        this._logger?.info?.(
            `R2_UPLOAD_STARTED | bucket=${this._bucketName} | object=${destination}`
        );

        try {

            const existingObject = await this._headIfExists(destination);
            // Legacy callers keep create-once semantics. Financial room archives
            // opt in to revision-aware CAS updates of ONE stable R2 object key.
            if (existingObject && (revision === null
                || existingObject.Metadata?.wheelwinrevision === revision)) {
                this._logger?.info?.(
                    `R2_UPLOAD_ALREADY_PRESENT | bucket=${this._bucketName} | object=${destination}`
                );
                return { objectName:destination,
                    generation:existingObject.VersionId ?? existingObject.ETag ?? null,
                    etag:existingObject.ETag ?? null, alreadyPresent:true };
            }
            if (revision !== null && (!/^[a-f0-9]{24}$/.test(revision))) {
                throw new Error("R2_INVALID_FINANCIAL_REVISION");
            }
            if (existingObject && !existingObject.ETag) {
                throw new Error("R2_ARCHIVE_MISSING_ETAG");
            }

            let putResult;
            try {
                putResult = await this._client.send(new PutObjectCommand({
                    Bucket: this._bucketName,
                    Key: destination,
                    Body: createReadStream(localPath),
                    // Stable room key, conditional create or compare-and-swap update.
                    // A stale writer must never silently overwrite newer evidence.
                    ...(existingObject ? { IfMatch: existingObject.ETag } : { IfNoneMatch: "*" }),
                    ...(revision !== null ? { Metadata: { wheelwinrevision: revision } } : {}),
                    // R2 S3-compatible endpoint needs a fixed payload length for
                    // reliable streamed uploads (avoid ambiguous chunked bodies).
                    ContentLength: statSync(localPath).size,
                    ContentType: "application/zip",
                    CacheControl: "private, max-age=0, no-transform"
                }));
            } catch (error) {
                if (isPreconditionFailed(error)) {
                    const racedObject = await this._headIfExists(destination);
                    if (racedObject && (revision === null
                        || racedObject.Metadata?.wheelwinrevision === revision)) {
                        return { objectName:destination,
                            generation:racedObject.VersionId ?? racedObject.ETag ?? null,
                            etag:racedObject.ETag ?? null, alreadyPresent:true };
                    }
                    throw new Error("R2_ARCHIVE_CONCURRENT_UPDATE");
                }
                throw error;
            }

            const head = await this._client.send(new HeadObjectCommand({
                Bucket: this._bucketName,
                Key: destination
            }));

            const etag = head?.ETag
                ?? putResult?.ETag
                ?? null;

            this._logger?.info?.(
                `R2_UPLOAD_SUCCESS | bucket=${this._bucketName} | object=${destination}`
            );

            return {
                objectName: destination,
                generation: head?.VersionId ?? null,
                etag: etag ? String(etag).replace(/"/g, "") : null
            };

        } catch (error) {

            this._logger?.error?.(
                `R2_UPLOAD_FAILED | bucket=${this._bucketName}`
                + ` | object=${destination} | error=${error.message}`
            );

            throw error;

        }

    }

    async _headIfExists(key) {
        try {
            return await this._client.send(new HeadObjectCommand({ Bucket:this._bucketName, Key:key }));
        } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
    }

}

function isNotFound(error) {
    return error?.$metadata?.httpStatusCode === 404
        || error?.$metadata?.httpStatusCode === 403 && error?.name === "NotFound"
        || ["NotFound", "NoSuchKey", "NoSuchObject"].includes(error?.name);
}

function isPreconditionFailed(error) {
    return error?.$metadata?.httpStatusCode === 412
        || ["PreconditionFailed", "ConditionalRequestConflict"].includes(error?.name);
}

/**
 * Test double — records uploads without contacting Cloudflare R2.
 */
export class MockForensicArchiveUploader {

    constructor() {

        this.uploads = [];
        this.objects = new Map();

        this.shouldFail = false;

    }

    isConfigured() {

        return true;

    }

    async uploadFile(localPath, objectName, { revision = null } = {}) {

        if (this.shouldFail) {

            throw new Error("Mock R2 upload failure");

        }

        const previous = this.objects.get(objectName);
        if (previous && revision !== null && previous.revision === revision) {
            return { objectName, generation:"mock-generation", etag:previous.etag,
                alreadyPresent:true };
        }
        const etag = "mock-etag-" + (this.uploads.length + 1);
        this.uploads.push({ localPath, objectName, revision });
        this.objects.set(objectName, { localPath, revision, etag });
        return { objectName, generation:"mock-generation", etag };

    }

}
