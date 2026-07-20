import { memo } from "react";

import "./centralButton.css";

function CentralButtonView({ snapshot, onPress, onRelease }) {

    const { presentation, isPressed, locked } = snapshot;

    const {
        label,
        backgroundColor,
        borderColor,
        textColor,
        pulseClass,
        enabled
    } = presentation;

    const interactive = enabled && typeof onPress === "function";

    const classNames = [
        "centerButton",
        pulseClass,
        isPressed ? "centerButton--pressed" : "",
        locked ? "centerButton--locked" : ""
    ].filter(Boolean).join(" ");

    return (

        <button
            type="button"
            className={classNames}
            style={{
                backgroundColor,
                borderColor,
                color: textColor
            }}
            aria-label={label}
            disabled={!interactive}
            onPointerDown={interactive ? (event) => {

                event.preventDefault();

                onPress();

            } : undefined}
            onPointerUp={interactive ? onRelease : undefined}
            onPointerCancel={interactive ? onRelease : undefined}
            onPointerLeave={interactive ? (event) => {

                if (event.buttons === 0) {

                    onRelease();

                }

            } : undefined}
        >

            {label}

        </button>

    );

}

export default memo(CentralButtonView);
