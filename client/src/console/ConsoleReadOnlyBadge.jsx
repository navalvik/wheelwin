/**
 * R6.0B — Read-only badge for the WheelWin Developer Console.
 */
export default function ConsoleReadOnlyBadge() {

    return (

        <div
            className="devConsole__readOnly"
            role="status"
            aria-label="Read only console"
        >

            <span className="devConsole__readOnlyBadge">

                READ ONLY

            </span>

            <p className="devConsole__readOnlyText">

                This console never modifies authoritative game state.

            </p>

        </div>

    );

}
