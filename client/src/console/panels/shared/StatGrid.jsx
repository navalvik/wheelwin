export function StatGrid({ children }) {

    return (

        <div className="devConsole__statGrid">

            {children}

        </div>

    );

}

export function StatCard({ label, value, hint = null, tone = null }) {

    return (

        <div
            className={
                tone
                    ? `devConsole__statCard devConsole__statCard--${tone}`
                    : "devConsole__statCard"
            }
        >

            <div className="devConsole__statLabel">

                {label}

            </div>

            <div className="devConsole__statValue">

                {value ?? "—"}

            </div>

            {hint && (

                <div className="devConsole__statHint">

                    {hint}

                </div>

            )}

        </div>

    );

}
