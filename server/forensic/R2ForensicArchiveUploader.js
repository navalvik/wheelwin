import { createReadStream } from "node:fs";
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
    async uploadFile(localPath, objectName) {

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

            const putResult = await this._client.send(new PutObjectCommand({
                Bucket: this._bucketName,
                Key: destination,
                Body: createReadStream(localPath),
                ContentType: "application/zip",
                CacheControl: "private, max-age=0, no-transform"
            }));

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

}

/**
 * Test double — records uploads without contacting Cloudflare R2.
 */
export class MockForensicArchiveUploader {

    constructor() {

        this.uploads = [];

        this.shouldFail = false;

    }

    isConfigured() {

        return true;

    }

    async uploadFile(localPath, objectName) {

        if (this.shouldFail) {

            throw new Error("Mock R2 upload failure");

        }

        this.uploads.push({ localPath, objectName });

        return {
            objectName,
            generation: "mock-generation",
            etag: "mock-etag"
        };

    }

}
