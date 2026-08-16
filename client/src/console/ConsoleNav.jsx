import { useCallback, useEffect, useMemo, useState } from "react";

import {
    CONSOLE_GROUPS,
    getConsoleNavTree,
    getConsoleSection
} from "./consoleSections";

const EXPANDED_STORAGE_KEY = "wheelwin.devConsole.navExpandedGroups";

function readExpandedGroups() {

    const defaults = {};

    for (const group of CONSOLE_GROUPS) {

        defaults[group.id] = Boolean(group.defaultExpanded);

    }

    try {

        const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);

        if (!raw) {

            return defaults;

        }

        const parsed = JSON.parse(raw);

        if (!parsed || typeof parsed !== "object") {

            return defaults;

        }

        const next = { ...defaults };

        for (const group of CONSOLE_GROUPS) {

            if (typeof parsed[group.id] === "boolean") {

                next[group.id] = parsed[group.id];

            }

        }

        return next;

    } catch {

        return defaults;

    }

}

function writeExpandedGroups(map) {

    try {

        window.localStorage.setItem(
            EXPANDED_STORAGE_KEY,
            JSON.stringify(map)
        );

    } catch {

        // ignore quota / private mode

    }

}

/**
 * R6.0B / R17.9F.2 — Grouped collapsible Developer Console navigation.
 */
export default function ConsoleNav({
    activeSectionId,
    onSelectSection
}) {

    const navTree = useMemo(() => getConsoleNavTree(), []);

    const [expandedByGroup, setExpandedByGroup] = useState(readExpandedGroups);

    // Ensure the group that owns the active section is expanded.
    useEffect(() => {

        const activeGroup = getConsoleSection(activeSectionId).group;

        setExpandedByGroup((prev) => {

            if (prev[activeGroup]) {

                return prev;

            }

            const next = { ...prev, [activeGroup]: true };

            writeExpandedGroups(next);

            return next;

        });

    }, [activeSectionId]);

    const toggleGroup = useCallback((groupId) => {

        setExpandedByGroup((prev) => {

            const next = {
                ...prev,
                [groupId]: !prev[groupId]
            };

            writeExpandedGroups(next);

            return next;

        });

    }, []);

    return (

        <nav className="devConsole__nav" aria-label="Developer Console sections">

            <ul className="devConsole__navGroups">

                {navTree.map(({ group, sections }) => {

                    const expanded = Boolean(expandedByGroup[group.id]);
                    const panelId = `devConsole-nav-group-${group.id}`;

                    return (

                        <li key={group.id} className="devConsole__navGroup">

                            <button
                                type="button"
                                className="devConsole__navGroupToggle"
                                aria-expanded={expanded}
                                aria-controls={panelId}
                                onClick={() => toggleGroup(group.id)}
                            >

                                <span className="devConsole__navGroupLabel">

                                    {group.label}

                                </span>

                                <span
                                    className={
                                        expanded
                                            ? "devConsole__navGroupChevron devConsole__navGroupChevron--open"
                                            : "devConsole__navGroupChevron"
                                    }
                                    aria-hidden="true"
                                >

                                    ▾

                                </span>

                            </button>

                            {expanded && (

                                <ul
                                    id={panelId}
                                    className="devConsole__navList"
                                >

                                    {sections.map((section) => {

                                        const active = section.id
                                            === activeSectionId;

                                        return (

                                            <li key={section.id}>

                                                <button
                                                    type="button"
                                                    className={
                                                        active
                                                            ? "devConsole__navButton devConsole__navButton--active"
                                                            : "devConsole__navButton"
                                                    }
                                                    aria-current={
                                                        active
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    onClick={() => {
                                                        onSelectSection(
                                                            section.id
                                                        );
                                                    }}
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

                            )}

                        </li>

                    );

                })}

            </ul>

        </nav>

    );

}
