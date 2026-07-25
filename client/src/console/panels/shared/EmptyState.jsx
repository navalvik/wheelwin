export default function EmptyState({ title, detail = null }) {

    return (

        <div className="devConsole__empty">

            <p className="devConsole__emptyTitle">

                {title}

            </p>

            {detail && (

                <p className="devConsole__emptyDetail">

                    {detail}

                </p>

            )}

        </div>

    );

}
