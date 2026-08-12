import { Storage } from "@google-cloud/storage";

/**
 * R13.9F — Upload forensic ZIP archives to a private GCS bucket.
 * No public URLs are generated.
 */
export class GcsForensicArchiveUploader {

    constructor({
        logger = null,
        bucket,
        prefix = "forensic-archives",
        credentialsJson = ""
    } = {}) {

        this._logger = logger;
        this._bucketName = bucket;
        this._prefix = prefix.replace(/^\/+|\/+$/g, "");

        this._storage = this._createStorage(credentialsJson);

    }

    _createStorage(credentialsJson) {

        if (credentialsJson) {

            try {

                const credentials = JSON.parse(credentialsJson);

                return new Storage({ credentials });

            } catch (error) {

                throw new Error(
                    `Invalid GCS_SERVICE_ACCOUNT_JSON: ${error.message}`
                );

            }

        }

        return new Storage();

    }

    isConfigured() {

        return Boolean(this._bucketName);

    }

    /**
     * @returns {Promise<{ objectName: string, generation: string|null }>}
     */
    async uploadFile(localPath, objectName) {

        if (!this._bucketName) {

            throw new Error("GCS forensic bucket is not configured");

        }

        const destination = this._prefix
            ? `${this._prefix}/${objectName}`
            : objectName;

        const bucket = this._storage.bucket(this._bucketName);

        const [file] = await bucket.upload(localPath, {
            destination,
            resumable: true,
            validation: "crc32c",
            metadata: {
                cacheControl: "private, max-age=0, no-transform"
            }
        });

        try {

            await file.makePrivate();

        } catch {

            // Uniform bucket-level access — object ACLs not required.

        }

        const [metadata] = await file.getMetadata();

        return {
            objectName: destination,
            generation: metadata?.generation ?? null
        };

    }

}

/**
 * Test double — records uploads without contacting GCS.
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

            throw new Error("Mock GCS upload failure");

        }

        this.uploads.push({ localPath, objectName });

        return {
            objectName,
            generation: "mock-generation"
        };

    }

}
