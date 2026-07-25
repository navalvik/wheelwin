import ConsoleNav from "./ConsoleNav";

/**
 * R6.0B — Console layout: side navigation + main content.
 */
export default function ConsoleLayout({
    activeSectionId,
    onSelectSection,
    children
}) {

    return (

        <div className="devConsole__layout">

            <aside className="devConsole__sidebar">

                <ConsoleNav
                    activeSectionId={activeSectionId}
                    onSelectSection={onSelectSection}
                />

            </aside>

            <main className="devConsole__main">

                {children}

            </main>

        </div>

    );

}
