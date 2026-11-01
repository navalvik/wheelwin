/**
 * Display-only coalescing for server-authoritative physics frames.
 *
 * The server emits physics updates at its 10 ms fixed simulation step.
 * Rendering two high-DPI canvases synchronously for every packet can
 * monopolize a low-end Telegram WebView. This scheduler NEVER changes
 * physics packets or angles: each draw reads the latest authoritative
 * frame, skipping only intermediate visual redraws.
 */
export const MIN_CANVAS_FRAME_INTERVAL_MS = 32; // <= approximately 31 FPS

export function createLatestFrameRenderer(draw, {
    requestFrame = callback => requestAnimationFrame(callback),
    cancelFrame = handle => cancelAnimationFrame(handle),
    minFrameIntervalMs = MIN_CANVAS_FRAME_INTERVAL_MS
} = {}) {
    if (typeof draw !== "function") {
        throw new TypeError("A canvas draw callback is required");
    }

    let frameHandle = null;
    let disposed = false;
    let lastDrawAt = null;

    const onFrame = timestamp => {
        frameHandle = null;
        if (disposed) return;

        if (lastDrawAt !== null
            && Number.isFinite(timestamp)
            && timestamp - lastDrawAt < minFrameIntervalMs) {
            frameHandle = requestFrame(onFrame);
            return;
        }

        lastDrawAt = Number.isFinite(timestamp) ? timestamp : lastDrawAt;
        draw();
    };

    return {
        request() {
            if (disposed || frameHandle !== null) return;
            frameHandle = requestFrame(onFrame);
        },
        dispose() {
            disposed = true;
            if (frameHandle !== null) {
                cancelFrame(frameHandle);
                frameHandle = null;
            }
        }
    };
}
