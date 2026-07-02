export default function HeaderBar({
    message,
    nextEnabled = false,
    showNextButton = true,
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

            <div className="center">

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
                        disabled={!nextEnabled}
                        onClick={onNext}
                    >
                        NEXT
                    </button>

                )}

            </div>

        </div>

    );

}