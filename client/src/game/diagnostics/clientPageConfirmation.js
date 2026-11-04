export const CLIENT_PAGE_NAMES = Object.freeze({
    1: "PAGE1_WELCOME",
    2: "ROOM_LOBBY",
    3: "PAGE2_PLAYER_SETUP",
    4: "PAGE_MATRIX",
    5: "PAGE3_VERIFY_PLAYERS",
    6: "PAGE4_PAYMENT",
    7: "PAGE5_GAME",
    8: "PAGE6_RESULT",
    9: "ENTRY_MODE",
    10: "NO_FRIENDS_QUEUE",
    11: "NO_FRIENDS_OPTIONS"
});

export function nextClientPageSequence(previousSequence, storedSequence = 0) {
    const previous = Number.isSafeInteger(previousSequence) ? previousSequence : 0;
    const stored = Number.isSafeInteger(storedSequence) ? storedSequence : 0;
    return Math.max(previous, stored) + 1;
}

export function createClientPageConfirmation({
    roomId = null,
    gameId = null,
    playerId = null,
    page,
    sequenceNumber,
    clientEventAt = Date.now(),
    requestedPage = null,
    requestedFromPage = null,
    navigationRequestedAt = null,
    uiState = null
} = {}) {
    const pageName = CLIENT_PAGE_NAMES[page] ?? null;
    if (!pageName || !Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
        return null;
    }
    return Object.freeze({
        roomId,
        gameId,
        playerId,
        page: pageName,
        sequenceNumber,
        clientEventAt,
        requestedPage: CLIENT_PAGE_NAMES[requestedPage] ?? null,
        requestedFromPage: CLIENT_PAGE_NAMES[requestedFromPage] ?? null,
        navigationRequestedAt: Number.isFinite(navigationRequestedAt)
            ? navigationRequestedAt
            : null,
        uiState: uiState ? Object.freeze({
            requestedPage: CLIENT_PAGE_NAMES[requestedPage] ?? null,
            appliedPage: pageName,
            mounted: uiState.mounted === true,
            visible: uiState.visible === true,
            documentVisible: uiState.documentVisible === true,
            topmostAtSample: uiState.topmostAtSample === true,
            blockingUi: Object.freeze(Array.isArray(uiState.blockingUi)
                ? [...uiState.blockingUi].slice(0, 8)
                : [])
        }) : null
    });
}

/** Keep only the newest route while offline; reconnect sends one latest snapshot. */
export function createClientPageConfirmationOutbox() {
    let latest = null;
    return Object.freeze({
        publish(event, connected, emit) {
            latest = event;
            if (connected && latest && typeof emit === "function") emit(latest);
            return latest;
        },
        replay(connected, emit) {
            if (connected && latest && typeof emit === "function") emit(latest);
            return latest;
        },
        replaceLatest(event) {
            if (event) latest = event;
            return latest;
        },
        getLatest() {
            return latest;
        }
    });
}

export function inspectPageUi(documentObject, pageName) {
    if (!documentObject || !pageName) return null;
    const root = documentObject.querySelector(
        `[data-wheelwin-app-page-root="${pageName}"]`
    );
    const documentVisible = documentObject.visibilityState !== "hidden";
    const visibleElement = (element) => {
        if (!element || typeof element.getBoundingClientRect !== "function") return false;
        const style = documentObject.defaultView?.getComputedStyle?.(element);
        if (style?.display === "none" || style?.visibility === "hidden"
            || Number(style?.opacity ?? 1) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };
    const descendants = root ? [...root.querySelectorAll("*")] : [];
    const visibleDescendants = descendants.filter(visibleElement);
    const mounted = Boolean(root && root.childElementCount > 0);
    const pageVisible = mounted && visibleDescendants.length > 0;
    let topmostAtSample = false;
    if (pageVisible && typeof documentObject.elementFromPoint === "function") {
        for (const element of visibleDescendants.slice(0, 20)) {
            const rect = element.getBoundingClientRect();
            const hit = documentObject.elementFromPoint(
                Math.floor(rect.left + rect.width / 2),
                Math.floor(rect.top + rect.height / 2)
            );
            if (hit && root.contains(hit)) {
                topmostAtSample = true;
                break;
            }
        }
    } else if (pageVisible) {
        topmostAtSample = true;
    }
    const blockingUi = [...documentObject.querySelectorAll(
        '[aria-modal="true"], [role="dialog"], [data-wheelwin-blocking-ui]'
    )].filter(visibleElement).map((element) =>
        element.getAttribute("aria-label")
            || element.getAttribute("data-wheelwin-blocking-ui")
            || element.getAttribute("role")
            || element.tagName.toLowerCase()
    );
    return Object.freeze({
        mounted,
        documentVisible,
        visible: documentVisible && pageVisible && topmostAtSample,
        topmostAtSample,
        blockingUi: Object.freeze(blockingUi.slice(0, 8))
    });
}
