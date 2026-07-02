import {
    TRIANGLE_FILL_COLOR,
    TRIANGLE_INITIAL_ANGLE,
    TRIANGLE_OUTLINE_COLOR,
    calculateTriangleHeight,
    calculateTriangleWidth,
    calculateWheelCenter,
    degreesToPointerRadians
} from "./triangleUtils";

export class TriangleEngine {

    constructor(canvas) {

        if (!canvas) {

            throw new Error("TriangleEngine requires a canvas element");

        }

        this._canvas = canvas;

        this._ctx = canvas.getContext("2d");

        this._angle = TRIANGLE_INITIAL_ANGLE;

        this._wheelRadius = 0;

        this._width = 0;

        this._height = 0;

    }

    setAngle(angleDegrees) {

        this._angle = angleDegrees;

    }

    getAngle() {

        return this._angle;

    }

    setWheelRadius(radius) {

        this._wheelRadius = Math.max(0, radius);

    }

    getWheelRadius() {

        return this._wheelRadius;

    }

    resize(width, height) {

        const nextWidth = Math.max(0, Math.floor(width));

        const nextHeight = Math.max(0, Math.floor(height));

        if (nextWidth === this._width && nextHeight === this._height) {

            return;

        }

        this._width = nextWidth;

        this._height = nextHeight;

        const dpr = window.devicePixelRatio || 1;

        this._canvas.width = Math.floor(nextWidth * dpr);

        this._canvas.height = Math.floor(nextHeight * dpr);

        this._canvas.style.width = `${nextWidth}px`;

        this._canvas.style.height = `${nextHeight}px`;

        this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    }

    render() {

        if (this._width <= 0 || this._height <= 0 || this._wheelRadius <= 0) {

            return;

        }

        const ctx = this._ctx;

        const wheelCenter = calculateWheelCenter(this._width, this._height);

        const wheelDiameter = this._wheelRadius * 2;

        const triangleHeight = calculateTriangleHeight(wheelDiameter);

        const triangleWidth = calculateTriangleWidth(wheelDiameter);

        const pointerAngle = degreesToPointerRadians(this._angle);

        const tipX = wheelCenter.x
            + (Math.cos(pointerAngle) * this._wheelRadius);

        const tipY = wheelCenter.y
            + (Math.sin(pointerAngle) * this._wheelRadius);

        const outwardX = Math.cos(pointerAngle);

        const outwardY = Math.sin(pointerAngle);

        const perpX = -outwardY;

        const perpY = outwardX;

        const baseCenterX = tipX + (outwardX * triangleHeight);

        const baseCenterY = tipY + (outwardY * triangleHeight);

        const halfWidth = triangleWidth / 2;

        ctx.clearRect(0, 0, this._width, this._height);

        ctx.beginPath();

        ctx.moveTo(tipX, tipY);

        ctx.lineTo(
            baseCenterX + (perpX * halfWidth),
            baseCenterY + (perpY * halfWidth)
        );

        ctx.lineTo(
            baseCenterX - (perpX * halfWidth),
            baseCenterY - (perpY * halfWidth)
        );

        ctx.closePath();

        ctx.fillStyle = TRIANGLE_FILL_COLOR;

        ctx.fill();

        ctx.strokeStyle = TRIANGLE_OUTLINE_COLOR;

        ctx.lineWidth = Math.max(1, wheelDiameter * 0.002);

        ctx.stroke();

    }

}
