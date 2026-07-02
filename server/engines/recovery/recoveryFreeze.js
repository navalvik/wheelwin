export function deepFreezeRecovery(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    Object.freeze(value);

    for (const key of Object.keys(value)) {

        deepFreezeRecovery(value[key]);

    }

    return value;

}
