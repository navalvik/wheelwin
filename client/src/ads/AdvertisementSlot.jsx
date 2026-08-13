/**
 * R14.5 — AdvertisementSlot
 * Renders the server snapshot or WheelWin fallback. No rotation logic.
 */

import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";

import Banner from "../components/Banner";
import { GameSessionContext } from "../context/GameSessionContext";
import socket from "../socket/socket";

import "./advertisement.css";
import {
    getAdvertisementSyncClient,
    resolveAdvertisementRenderModel,
    WHEELWIN_FALLBACK_BANNER_SRC
} from "./AdvertisementSyncClient";
import { openAdvertisementDestination } from "./openAdvertisementDestination";

function subscribeToAdvertisement(listener) {

    const client = getAdvertisementSyncClient();

    return client.subscribe(listener);

}

function getAdvertisementSnapshot() {

    return getAdvertisementSyncClient().getSnapshot();

}

export default function AdvertisementSlot() {

    const gameSession = useContext(GameSessionContext);
    const currentPage = gameSession?.currentPage;
    const snapshot = useSyncExternalStore(
        subscribeToAdvertisement,
        getAdvertisementSnapshot,
        getAdvertisementSnapshot
    );
    const [imageFailed, setImageFailed] = useState(false);

    useEffect(() => {

        try {

            getAdvertisementSyncClient().ensureAttached(socket);

        } catch {

            // Socket attach failure must not crash the shell.

        }

    }, []);

    useEffect(() => {

        setImageFailed(false);

    }, [snapshot?.advertisementId, snapshot?.filename, currentPage]);

    const model = resolveAdvertisementRenderModel({
        page: currentPage,
        snapshot,
        imageFailed
    });

    const handleError = useCallback(() => {

        setImageFailed(true);

    }, []);

    const handleClick = useCallback(() => {

        if (!model.clickable || !model.destinationUrl) {

            return;

        }

        try {

            openAdvertisementDestination(model.destinationUrl);

        } catch {

            // Click handling must never break the app.

        }

    }, [model.clickable, model.destinationUrl]);

    // Brand-only pages / missing ads → existing WheelWin Banner architecture.
    if (model.mode === "fallback") {

        return <Banner />;

    }

    const Frame = model.clickable ? "button" : "div";

    return (

        <div className="banner advertisementSlot advertisementSlot--external">

            <Frame
                type={model.clickable ? "button" : undefined}
                className={
                    model.clickable
                        ? "advertisementSlot__frame advertisementSlot__frame--clickable"
                        : "advertisementSlot__frame"
                }
                onClick={model.clickable ? handleClick : undefined}
                aria-label={model.alt}
            >

                <img
                    className="advertisementSlot__image"
                    src={model.src || WHEELWIN_FALLBACK_BANNER_SRC}
                    alt={model.alt}
                    style={{ objectFit: model.objectFit || "contain" }}
                    onError={handleError}
                    draggable={false}
                />

            </Frame>

        </div>

    );

}
