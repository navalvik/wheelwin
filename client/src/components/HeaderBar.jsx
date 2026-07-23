export default function HeaderBar({
    message,
    messageClassName = "",
    nextEnabled = false,
    showNextButton = true,
    nextLabel = "NEXT",
    backEnabled = false,
    onBack,
    onNext,
    showJumpButton = false,
    onJump
}) {

    return (

        <div className={`headerBar${showJumpButton ? " headerBar--dev" : ""}`}>

            <div className="left">

                {backEnabled && (
                    <button
                        type="button"
                        onClick={onBack}
                    >
                        BACK
                    </button>
                )}

            </div>

            <div className={`center${messageClassName ? ` ${messageClassName}` : ""}`}>

                {message}

            </div>

            {showJumpButton && (

                <div className="jump">

                    <button
                        type="button"
                        className="jumpButton"
                        onClick={onJump}
                    >
                        JUMP
                    </button>

                </div>

            )}

            <div className="right">

                {showNextButton && (

                    <button
                        type="button"
                        disabled={!nextEnabled}
                        onClick={onNext}
                    >
                        {nextLabel}
                    </button>

                )}

            </div>

        </div>

    );

}