export { default as TriangleEngine } from "./TriangleEngine";

export { TriangleEngine as TriangleEngineCore } from "./TriangleRenderer";

export {
    TRIANGLE_INITIAL_ANGLE,
    TRIANGLE_HEIGHT_RATIO,
    TRIANGLE_WIDTH_RATIO,
    TRIANGLE_DEBUG_ANGLES,
    degreesToPointerRadians,
    calculateTriangleHeight,
    calculateTriangleWidth,
    calculateWheelCenter,
    calculateWheelRadiusFromContainer
} from "./triangleUtils";
