export const TRIANGLE_INITIAL_ANGLE = 0;

export const TRIANGLE_HEIGHT_RATIO = 0.04;

export const TRIANGLE_WIDTH_RATIO = 0.03;

export const TRIANGLE_FILL_COLOR = "#d62828";

export const TRIANGLE_OUTLINE_COLOR = "#b81f1f";

export const TRIANGLE_DEBUG_ANGLES = Object.freeze([
    0,
    45,
    90,
    180,
    270
]);

export function degreesToPointerRadians(angleDegrees) {

    return (angleDegrees * (Math.PI / 180)) - (Math.PI / 2);

}

export function calculateTriangleHeight(wheelDiameter) {

    return wheelDiameter * TRIANGLE_HEIGHT_RATIO;

}

export function calculateTriangleWidth(wheelDiameter) {

    return wheelDiameter * TRIANGLE_WIDTH_RATIO;

}

export function calculateWheelCenter(width, height) {

    const discSize = width;

    const markerHeight = Math.max(0, height - width);

    return {
        x: width / 2,
        y: markerHeight + (discSize / 2)
    };

}

export function calculateWheelRadiusFromContainer(width) {

    return (width * 0.92) / 2;

}
