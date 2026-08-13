/**
 * R16.8 — Async Cloudflare R2 client for advertisement campaigns + assets.
 * Private bucket; no public URLs generated.
 */

import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client
} from "@aws-sdk/client-s3";

import { ALLOWED_MIME_HINTS } from "./advertisementTypes.js";
import { resolveAdvertisementR2Config } from "./advertisementR2Config.js";

function streamToBuffer(body) {

    if (!body) {

        return Promise.resolve(null);

    }

    if (Buffer.isBuffer(body)) {

        return Promise.resolve(body);

    }

    if (typeof body.transformToByteArray === "function") {

        return body.transformToByteArray().then((arr) => Buffer.from(arr));

    }

    return new Promise((resolve, reject) => {

        const chunks = [];

        body.on("data", (chunk) => chunks.push(chunk));
        body.on("error", reject);
        body.on("end", () => resolve(Buffer.concat(chunks)));

    });

}

export function createAdvertisementR2Client(config = resolveAdvertisementR2Config()) {

    const endpoint = config.endpoint
        || (config.accountId
            ? `https://${config.accountId}.r2.cloudflarestorage.com`
            : "");

    if (!config.useR2 || !endpoint) {

        return null;

    }

    return new S3Client({
        region: "auto",
        endpoint,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        },
        forcePathStyle: true
    });

}

export class AdvertisementR2Client {

    constructor({
        logger = null,
        config = null,
        client = null
    } = {}) {

        this._logger = logger;
        this._config = config ?? resolveAdvertisementR2Config();
        this._client = client ?? createAdvertisementR2Client(this._config);

    }

    isConfigured() {

        return Boolean(this._config.useR2 && this._client);

    }

    campaignKey(campaignId) {

        return `${this._config.campaignsPrefix}/${campaignId}.json`;

    }

    assetKey(filename) {

        return `${this._config.assetsPrefix}/${filename}`;

    }

    resolveAssetContentType(filename) {

        const ext = String(filename || "").split(".").pop()?.toLowerCase() ?? "";

        return ALLOWED_MIME_HINTS[ext] || "application/octet-stream";

    }

    async putCampaign(campaign) {

        const key = this.campaignKey(campaign.id);
        const body = `${JSON.stringify(campaign, null, 2)}\n`;

        await this._client.send(new PutObjectCommand({
            Bucket: this._config.bucket,
            Key: key,
            Body: body,
            ContentType: "application/json",
            CacheControl: "private, max-age=0, no-transform"
        }));

        return { key, campaign };

    }

    async getCampaign(campaignId) {

        const key = this.campaignKey(campaignId);

        try {

            const response = await this._client.send(new GetObjectCommand({
                Bucket: this._config.bucket,
                Key: key
            }));

            const buffer = await streamToBuffer(response.Body);

            if (!buffer) {

                return null;

            }

            return JSON.parse(buffer.toString("utf8"));

        } catch (error) {

            if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {

                return null;

            }

            throw error;

        }

    }

    async deleteCampaign(campaignId) {

        const key = this.campaignKey(campaignId);

        await this._client.send(new DeleteObjectCommand({
            Bucket: this._config.bucket,
            Key: key
        }));

        return true;

    }

    async listCampaignIds() {

        const ids = [];
        let continuationToken = undefined;

        do {

            const response = await this._client.send(new ListObjectsV2Command({
                Bucket: this._config.bucket,
                Prefix: `${this._config.campaignsPrefix}/`,
                ContinuationToken: continuationToken
            }));

            for (const entry of response.Contents ?? []) {

                const name = entry.Key?.slice(this._config.campaignsPrefix.length + 1);

                if (name?.endsWith(".json")) {

                    ids.push(name.replace(/\.json$/i, ""));

                }

            }

            continuationToken = response.IsTruncated
                ? response.NextContinuationToken
                : undefined;

        } while (continuationToken);

        return ids;

    }

    async listCampaigns() {

        const ids = await this.listCampaignIds();
        const campaigns = [];

        for (const id of ids) {

            const campaign = await this.getCampaign(id);

            if (campaign) {

                campaigns.push(campaign);

            }

        }

        return campaigns.sort((left, right) => {

            const priorityDelta = (left.priority ?? 0) - (right.priority ?? 0);

            if (priorityDelta !== 0) {

                return priorityDelta;

            }

            return String(left.id).localeCompare(String(right.id));

        });

    }

    async putAsset(filename, bytes) {

        const key = this.assetKey(filename);

        await this._client.send(new PutObjectCommand({
            Bucket: this._config.bucket,
            Key: key,
            Body: bytes,
            ContentType: this.resolveAssetContentType(filename),
            CacheControl: "public, max-age=300"
        }));

        return {
            key,
            filename,
            sizeBytes: bytes.byteLength
        };

    }

    async headAsset(filename) {

        const key = this.assetKey(filename);

        try {

            const head = await this._client.send(new HeadObjectCommand({
                Bucket: this._config.bucket,
                Key: key
            }));

            return {
                filename,
                sizeBytes: Number(head.ContentLength) || 0
            };

        } catch (error) {

            if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) {

                return null;

            }

            throw error;

        }

    }

    async getAsset(filename) {

        const key = this.assetKey(filename);

        try {

            const response = await this._client.send(new GetObjectCommand({
                Bucket: this._config.bucket,
                Key: key
            }));

            return streamToBuffer(response.Body);

        } catch (error) {

            if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {

                return null;

            }

            throw error;

        }

    }

    async deleteAsset(filename) {

        const key = this.assetKey(filename);

        await this._client.send(new DeleteObjectCommand({
            Bucket: this._config.bucket,
            Key: key
        }));

    }

    async listAssetFilenames() {

        const names = [];
        let continuationToken = undefined;

        do {

            const response = await this._client.send(new ListObjectsV2Command({
                Bucket: this._config.bucket,
                Prefix: `${this._config.assetsPrefix}/`,
                ContinuationToken: continuationToken
            }));

            for (const entry of response.Contents ?? []) {

                const name = entry.Key?.slice(this._config.assetsPrefix.length + 1);

                if (name && !name.includes("/")) {

                    names.push(name);

                }

            }

            continuationToken = response.IsTruncated
                ? response.NextContinuationToken
                : undefined;

        } while (continuationToken);

        return names;

    }

    async measureAssetsBytes() {

        let total = 0;
        let continuationToken = undefined;

        do {

            const response = await this._client.send(new ListObjectsV2Command({
                Bucket: this._config.bucket,
                Prefix: `${this._config.assetsPrefix}/`,
                ContinuationToken: continuationToken
            }));

            for (const entry of response.Contents ?? []) {

                total += Number(entry.Size) || 0;

            }

            continuationToken = response.IsTruncated
                ? response.NextContinuationToken
                : undefined;

        } while (continuationToken);

        return total;

    }

}
