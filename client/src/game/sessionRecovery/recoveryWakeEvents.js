export function subscribeRecoveryWakeEvents({
    documentTarget,
    windowTarget,
    isEligible,
    onWake
}) {
    if (!documentTarget || !windowTarget) return () => {};

    const handleWake = (sourceEvent) => {
        if (documentTarget.visibilityState === "hidden" || !isEligible()) return;
        onWake(sourceEvent);
    };

    const onVisibilityChange = () => handleWake("visibilitychange");
    const onPageShow = () => handleWake("pageshow");

    documentTarget.addEventListener("visibilitychange", onVisibilityChange);
    windowTarget.addEventListener("pageshow", onPageShow);

    return () => {
        documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
        windowTarget.removeEventListener("pageshow", onPageShow);
    };
}
