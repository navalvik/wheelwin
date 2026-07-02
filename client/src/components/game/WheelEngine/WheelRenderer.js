import {
    WHEEL_ANGLE,
    calculateWheelDiameter,
    getSectorAngleRadians,
    getSectorMidAngleRadians,
    resolveWheelIcon,
    validateWheelConfiguration
} from "./wheelUtils";

const OUTER_BORDER_COLOR = "#1c73d0";

const SECTOR_BORDER_COLOR = "#ffffff";

const ICON_BORDER_COLOR = "#4f8dd8";

const CENTER_HOLE_BORDER_COLOR = "#1c73d0";

const CENTER_HOLE_RATIO = 0.2;

const ICON_RADIUS_RATIO = 0.075;

const ICON_DISTANCE_RATIO = 0.58;

export class WheelEngine {

    constructor(canvas) {

        if (!canvas) {

            throw new Error("WheelEngine requires a canvas element");

        }

        this._canvas = canvas;

        this._ctx = canvas.getContext("2d");

        this._configuration = null;

        this._width = 0;

        this._height = 0;

        this._angle = WHEEL_ANGLE;

        this._staticCanvas = null;

        this._staticDirty = true;

    }

    setConfiguration(config) {

        this._configuration = validateWheelConfiguration(config);

        this._staticDirty = true;

    }

    getConfiguration() {

        return this._configuration;

    }

    setAngle(angleDegrees) {

        this._angle = angleDegrees * (Math.PI / 180);

    }

    getAngle() {

        return this._angle * (180 / Math.PI);

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

        this._staticDirty = true;

    }

    render() {

        if (!this._configuration || this._width <= 0 || this._height <= 0) {

            return;

        }

        if (this._staticDirty) {

            this._rebuildStaticLayer();

        }

        const ctx = this._ctx;

        const centerX = this._width / 2;

        const centerY = this._height / 2;

        ctx.clearRect(0, 0, this._width, this._height);

        if (!this._staticCanvas) {

            return;

        }

        ctx.save();

        ctx.translate(centerX, centerY);

        ctx.rotate(this._angle);

        ctx.drawImage(
            this._staticCanvas,
            -centerX,
            -centerY,
            this._width,
            this._height
        );

        ctx.restore();

    }

    _rebuildStaticLayer() {

        const diameter = calculateWheelDiameter(this._width, this._height);

        const radius = diameter / 2;

        const centerX = this._width / 2;

        const centerY = this._height / 2;

        const { sectors } = this._configuration;

        const sectorCount = sectors.length;

        const sectorAngle = getSectorAngleRadians(sectorCount);

        const startAngle = -Math.PI / 2;

        if (!this._staticCanvas) {

            this._staticCanvas = document.createElement("canvas");

        }

        const dpr = window.devicePixelRatio || 1;

        this._staticCanvas.width = Math.floor(this._width * dpr);

        this._staticCanvas.height = Math.floor(this._height * dpr);

        const staticCtx = this._staticCanvas.getContext("2d");

        staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        staticCtx.clearRect(0, 0, this._width, this._height);

        sectors.forEach((sector, index) => {

            const sectorStart = startAngle + (index * sectorAngle);

            const sectorEnd = sectorStart + sectorAngle;

            staticCtx.beginPath();

            staticCtx.moveTo(centerX, centerY);

            staticCtx.arc(
                centerX,
                centerY,
                radius,
                sectorStart,
                sectorEnd
            );

            staticCtx.closePath();

            staticCtx.fillStyle = sector.color;

            staticCtx.fill();

        });

        staticCtx.strokeStyle = SECTOR_BORDER_COLOR;

        staticCtx.lineWidth = Math.max(2, radius * 0.008);

        for (let index = 0; index < sectorCount; index += 1) {

            const borderAngle = startAngle + (index * sectorAngle);

            staticCtx.beginPath();

            staticCtx.moveTo(centerX, centerY);

            staticCtx.lineTo(
                centerX + (Math.cos(borderAngle) * radius),
                centerY + (Math.sin(borderAngle) * radius)
            );

            staticCtx.stroke();

        }

        staticCtx.beginPath();

        staticCtx.arc(centerX, centerY, radius, 0, Math.PI * 2);

        staticCtx.strokeStyle = OUTER_BORDER_COLOR;

        staticCtx.lineWidth = Math.max(3, radius * 0.012);

        staticCtx.stroke();

        const holeRadius = radius * CENTER_HOLE_RATIO;

        staticCtx.beginPath();

        staticCtx.arc(centerX, centerY, holeRadius, 0, Math.PI * 2);

        staticCtx.fillStyle = "#ffffff";

        staticCtx.fill();

        staticCtx.strokeStyle = CENTER_HOLE_BORDER_COLOR;

        staticCtx.lineWidth = Math.max(2, radius * 0.01);

        staticCtx.stroke();

        const iconRadius = radius * ICON_RADIUS_RATIO;

        const iconDistance = radius * ICON_DISTANCE_RATIO;

        const iconFontSize = iconRadius * 1.35;

        staticCtx.textAlign = "center";

        staticCtx.textBaseline = "middle";

        sectors.forEach((sector, index) => {

            const midAngle = getSectorMidAngleRadians(
                index,
                sectorCount,
                0
            );

            const iconX = centerX + (Math.cos(midAngle) * iconDistance);

            const iconY = centerY + (Math.sin(midAngle) * iconDistance);

            staticCtx.beginPath();

            staticCtx.arc(iconX, iconY, iconRadius, 0, Math.PI * 2);

            staticCtx.fillStyle = "#ffffff";

            staticCtx.fill();

            staticCtx.strokeStyle = ICON_BORDER_COLOR;

            staticCtx.lineWidth = Math.max(1.5, radius * 0.006);

            staticCtx.stroke();

            staticCtx.font = `700 ${iconFontSize}px sans-serif`;

            staticCtx.fillStyle = "#222222";

            staticCtx.fillText(
                resolveWheelIcon(sector.icon),
                iconX,
                iconY
            );

        });

        this._staticDirty = false;

    }

}
