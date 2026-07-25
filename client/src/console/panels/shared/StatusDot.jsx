export function StatusDot({ tone = "unknown", label = null }) {

    return (

        <span
            className={`devConsole__statusDot devConsole__statusDot--${tone}`}
            title={label ?? tone}
        >

            {label && (

                <span className="devConsole__statusDotLabel">

                    {label}

                </span>

            )}

        </span>

    );

}

export function StatusBadge({ tone = "unknown", children }) {

    return (

        <span className={`devConsole__statusBadge devConsole__statusBadge--${tone}`}>

            <StatusDot tone={tone} />

            <span>

                {children}

            </span>

        </span>

    );

}
