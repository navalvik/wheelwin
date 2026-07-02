import { DEV_MODE } from "../config/devMode";

export function devLog(...args) {

    if (DEV_MODE) {

        console.log(...args);

    }

}

export function devWarn(...args) {

    if (DEV_MODE) {

        console.warn(...args);

    }

}
