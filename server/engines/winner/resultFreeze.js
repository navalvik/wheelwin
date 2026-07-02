export function deepFreezeResult(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    Object.freeze(value);

    for (const key of Object.keys(value)) {

        deepFreezeResult(value[key]);

    }

    return value;

}
