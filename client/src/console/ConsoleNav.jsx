import { CONSOLE_SECTIONS } from "./consoleSections";

/**
 * R6.0B — Top-level Developer Console navigation (placeholders only).
 */
export default function ConsoleNav({
    activeSectionId,
    onSelectSection
}) {

    return (

        <nav className="devConsole__nav" aria-label="Developer Console sections">

            <ul className="devConsole__navList">

                {CONSOLE_SECTIONS.map((section) => {

                    const active = section.id === activeSectionId;

                    return (

                        <li key={section.id}>

                            <button
                                type="button"
                                className={
                                    active
                                        ? "devConsole__navButton devConsole__navButton--active"
                                        : "devConsole__navButton"
                                }
                                aria-current={active ? "page" : undefined}
                                onClick={() => onSelectSection(section.id)}
                            >

                                <span>

                                    {section.label}

                                </span>

                                {section.reserved && (

                                    <span className="devConsole__navReserved">

                                        soon

                                    </span>

                                )}

                            </button>

                        </li>

                    );

                })}

            </ul>

        </nav>

    );

}
