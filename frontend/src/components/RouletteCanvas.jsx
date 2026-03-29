import React, { useEffect, useRef, useState } from 'react';

export default function RouletteCanvas({ sectors, speed, triangleSpeed, gameState, onSectorClick }) {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const [rotation, setRotation] = useState(0);
  const [triangleRotation, setTriangleRotation] = useState(0);
  const lastTimestamp = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.clientWidth;
    const height = canvas.height = canvas.clientHeight;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.4;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      // Рисуем сектора
      const angleStep = (Math.PI * 2) / sectors.length;
      for (let i = 0; i < sectors.length; i++) {
        const start = i * angleStep + rotation;
        const end = (i + 1) * angleStep + rotation;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, start, end);
        ctx.closePath();
        ctx.fillStyle = sectors[i]?.color || '#ccc';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.stroke();
      }

      // Рисуем красный треугольник (статичный относительно canvas, но вращаем его отдельно)
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(triangleRotation);
      ctx.beginPath();
      ctx.moveTo(radius + 20, 0);
      ctx.lineTo(radius - 10, -10);
      ctx.lineTo(radius - 10, 10);
      ctx.fillStyle = 'red';
      ctx.fill();
      ctx.restore();

      requestAnimationFrame(animate);
    };

    let lastTime = 0;
    const animate = (timestamp) => {
      if (!lastTime) lastTime = timestamp;
      const delta = Math.min(0.1, (timestamp - lastTime) / 1000);
      lastTime = timestamp;

      if (gameState === 'spin_phase' || gameState === 'braking') {
        setRotation(prev => prev + speed * Math.PI * 2 * delta);
        setTriangleRotation(prev => prev - triangleSpeed * Math.PI * 2 * delta);
      }

      draw();
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [sectors, speed, triangleSpeed, gameState]);

  const handleCanvasClick = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const dx = x - centerX;
    const dy = y - centerY;
    const distance = Math.hypot(dx, dy);
    if (distance < rect.width * 0.4) return; // клик в центр
    let angle = Math.atan2(dy, dx) - rotation;
    if (angle < 0) angle += Math.PI * 2;
    const sectorIndex = Math.floor(angle / (Math.PI * 2 / sectors.length));
    onSectorClick(sectorIndex);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleCanvasClick}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
