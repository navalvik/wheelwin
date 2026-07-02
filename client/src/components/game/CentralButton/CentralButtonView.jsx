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
            disabled={!enabled}
            onPointerDown={(event) => {

                event.preventDefault();

                onPress();

            }}
            onPointerUp={onRelease}
            onPointerCancel={onRelease}
            onPointerLeave={(event) => {

                if (event.buttons === 0) {

                    onRelease();

                }

            }}
        >

            {label}

        </button>

    );

}

export default memo(CentralButtonView);
