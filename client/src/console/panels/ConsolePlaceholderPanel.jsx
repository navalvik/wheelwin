/**
 * R6.0B — Empty placeholder panel for a console section.
 */
export default function ConsolePlaceholderPanel({
    title,
    reserved = false
}) {

    return (

        <section className="devConsole__panel" aria-labelledby="console-panel-title">

            <header className="devConsole__panelHeader">

                <h2 id="console-panel-title" className="devConsole__panelTitle">

                    {title}

                </h2>

                {reserved && (

                    <span className="devConsole__reservedTag">

                        Reserved

                    </span>

                )}

            </header>

            <div className="devConsole__panelBody">

                <p className="devConsole__placeholder">

                    {reserved
                        ? "This section is reserved for a later stage."
                        : "No data connected yet. Server projections arrive in a later stage."}

                </p>

            </div>

        </section>

    );

}
