export function deepFreezeConfiguration(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    Object.freeze(value);

    for (const key of Object.keys(value)) {

        deepFreezeConfiguration(value[key]);

    }

    return value;

}
