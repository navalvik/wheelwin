export function DataTable({ columns, rows, empty = "No rows." }) {

    if (!rows?.length) {

        return (

            <p className="devConsole__placeholder">

                {empty}

            </p>

        );

    }

    return (

        <div className="devConsole__tableWrap">

            <table className="devConsole__table">

                <thead>

                    <tr>

                        {columns.map((column) => (

                            <th key={column.key}>

                                {column.label}

                            </th>

                        ))}

                    </tr>

                </thead>

                <tbody>

                    {rows.map((row) => (

                        <tr
                            key={row.id}
                            className={row.className}
                            onClick={row.onClick}
                        >

                            {columns.map((column) => (

                                <td key={column.key}>

                                    {column.render
                                        ? column.render(row.data)
                                        : row.data[column.key]}

                                </td>

                            ))}

                        </tr>

                    ))}

                </tbody>

            </table>

        </div>

    );

}

export function KeyValueList({ entries }) {

    return (

        <dl className="devConsole__kv">

            {entries.map((entry) => (

                <div key={entry.label} className="devConsole__kvRow">

                    <dt>

                        {entry.label}

                    </dt>

                    <dd>

                        {entry.value ?? "—"}

                    </dd>

                </div>

            ))}

        </dl>

    );

}
