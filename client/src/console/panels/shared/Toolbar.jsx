export default function Toolbar({
    search = "",
    onSearchChange,
    searchPlaceholder = "Search…",
    children = null
}) {

    return (

        <div className="devConsole__toolbar">

            <label className="devConsole__search">

                <span className="devConsole__srOnly">

                    Search

                </span>

                <input
                    type="search"
                    value={search}
                    placeholder={searchPlaceholder}
                    onChange={(event) => onSearchChange?.(event.target.value)}
                />

            </label>

            {children && (

                <div className="devConsole__toolbarFilters">

                    {children}

                </div>

            )}

        </div>

    );

}

export function FilterSelect({ label, value, onChange, options }) {

    return (

        <label className="devConsole__filter">

            <span>

                {label}

            </span>

            <select
                value={value}
                onChange={(event) => onChange?.(event.target.value)}
            >

                {options.map((option) => (

                    <option key={option.value} value={option.value}>

                        {option.label}

                    </option>

                ))}

            </select>

        </label>

    );

}
