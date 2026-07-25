export default function PanelShell({
    title,
    subtitle = null,
    actions = null,
    children
}) {

    return (

        <section className="devConsole__panel" aria-label={title}>

            <header className="devConsole__panelHeader">

                <div className="devConsole__panelHeaderText">

                    <h2 className="devConsole__panelTitle">

                        {title}

                    </h2>

                    {subtitle && (

                        <p className="devConsole__panelSubtitle">

                            {subtitle}

                        </p>

                    )}

                </div>

                {actions && (

                    <div className="devConsole__panelActions">

                        {actions}

                    </div>

                )}

            </header>

            <div className="devConsole__panelBody devConsole__panelBody--ops">

                {children}

            </div>

        </section>

    );

}
