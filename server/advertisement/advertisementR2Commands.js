/**
 * R16.8 — R2 command executor (async; invoked from sync bridge CLI).
 */

import { AdvertisementR2Client } from "./advertisementR2Client.js";
import { resolveAdvertisementR2Config } from "./advertisementR2Config.js";

export async function executeAdvertisementR2Command(command, input = {}) {

    const config = resolveAdvertisementR2Config();
    const client = new AdvertisementR2Client({ config });

    if (!client.isConfigured()) {

        throw new Error("Advertisement R2 storage is not configured");

    }

    switch (command) {

        case "hydrate":
            return {
                campaigns: await client.listCampaigns(),
                assetFilenames: await client.listAssetFilenames(),
                usedBytes: await client.measureAssetsBytes()
            };

        case "putCampaign":
            return client.putCampaign(input.campaign);

        case "getCampaign":
            return client.getCampaign(input.campaignId);

        case "listCampaigns":
            return client.listCampaigns();

        case "deleteCampaign":
            return client.deleteCampaign(input.campaignId);

        case "putAsset":
            return client.putAsset(
                input.filename,
                Buffer.from(input.bytesBase64, "base64")
            );

        case "getAsset":
            return client.getAsset(input.filename);

        case "headAsset":
            return client.headAsset(input.filename);

        case "deleteAsset":
            return client.deleteAsset(input.filename);

        case "measureAssetsBytes":
            return client.measureAssetsBytes();

        default:
            throw new Error(`Unknown advertisement R2 command: ${command}`);

    }

}
