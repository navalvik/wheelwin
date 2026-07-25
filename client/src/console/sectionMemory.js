/**
 * R6.0E — Remember last Developer Console section in localStorage.
 */

import {
    DEFAULT_CONSOLE_SECTION_ID,
    getConsoleSection
} from "./consoleSections";

const STORAGE_KEY = "wheelwin.devConsole.activeSection";

export function readRememberedSectionId() {

    try {

        const raw = window.localStorage.getItem(STORAGE_KEY);

        if (!raw) {

            return DEFAULT_CONSOLE_SECTION_ID;

        }

        return getConsoleSection(raw).id;

    } catch {

        return DEFAULT_CONSOLE_SECTION_ID;

    }

}

export function rememberSectionId(sectionId) {

    try {

        window.localStorage.setItem(
            STORAGE_KEY,
            getConsoleSection(sectionId).id
        );

    } catch {

        // ignore quota / private mode

    }

}
