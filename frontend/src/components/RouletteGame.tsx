import { useEffect, useRef } from 'react';

interface Props {
  gameState: any;
  playerWallet: string;
  onSelectSector: (roomId: string, playerId: string, sectorId: number) => void;
  onConfirmPayment: (roomId: string, playerId: string, txHash: string) => void;
  onReady: (roomId: string, playerId: string) => void;
  onButtonToggle: (roomId: string, playerId: string, state: boolean) => void;
}

export default function RouletteGame({
  gameState,
  playerWallet,
  onSelectSector,
  onConfirmPayment,
  onReady,
  onButtonToggle
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { roomId, sectors, players, state, pot, currentAngle, timer, currentSpeed } = gameState;
  const currentPlayer = players?.find((p: any) => p.wallet === playerWallet);
  const isMyTurn = currentPlayer?.status === 'active';
  const isButtonActive = state === 'spinning' || state === 'control';

  // Отрисовка рулетки
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    const centerX = w/2, centerY = h/2;
    const radius = Math.min(w,h)/2 - 20;
    const sectorAngle = (Math.PI * 2) / sectors.length;
    let startAngle = currentAngle || 0;
    for (let i = 0; i < sectors.length; i++) {
      const endAngle = startAngle + sectorAngle;
      ctx.beginPath();
      ctx.fillStyle = sectors[i].ownerId ? '#4caf50' : '#f44336';
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, radius, startAngle, endAngle);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      startAngle = endAngle;
    }
  }, [sectors, currentAngle]);

  const handleSectorClick = (sectorId: number) => {
    if (state === 'sector_selection' && currentPlayer) {
      onSelectSector(roomId, currentPlayer.id, sectorId);
    }
  };

  const handlePay = async () => {
    if (state !== 'payment') return;
    // Используем TON Connect для отправки платежа
    // Здесь должен быть вызов tonConnect.sendTransaction()
    // Для примера – имитация txHash
    const fakeTxHash = '0x' + Math.random().toString(16);
    onConfirmPayment(roomId, currentPlayer.id, fakeTxHash);
  };

  const handleReady = () => {
    if (state === 'ready') {
      onReady(roomId, currentPlayer.id);
    }
  };

  const handleMouseDown = () => {
    if (isButtonActive) onButtonToggle(roomId, currentPlayer.id, true);
  };
  const handleMouseUp = () => {
    if (isButtonActive) onButtonToggle(roomId, currentPlayer.id, false);
  };

  return (
    <div className="game-container">
      <canvas ref={canvasRef} width={500} height={500} onClick={(e) => {
        // определить кликнутый сектор (упрощённо)
        // в реальном проекте – пересчёт координат
      }} />
      <div>Pot: {pot} TON</div>
      <div>State: {state}</div>
      <div>Timer: {timer?.toFixed(1)}s</div>
      <div>Speed: {currentSpeed?.toFixed(2)}</div>
      <div className="sectors">
        {sectors?.map((s: any) => (
          <button key={s.id} onClick={() => handleSectorClick(s.id)} disabled={state !== 'sector_selection'}>
            Sector {s.id} {s.ownerId === currentPlayer?.id && '(Your)'}
          </button>
        ))}
      </div>
      {state === 'payment' && currentPlayer && !currentPlayer.paid && (
        <button onClick={handlePay}>Pay {currentPlayer.sectors.length === 1 ? gameState.baseBet : gameState.baseBet * 2.5} TON</button>
      )}
      {state === 'ready' && currentPlayer && !currentPlayer.ready && (
        <button onClick={handleReady}>Ready</button>
      )}
      {(state === 'spinning' || state === 'control') && (
        <button
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onTouchStart={handleMouseDown}
          onTouchEnd={handleMouseUp}
          style={{ background: currentPlayer?.isButtonPressed ? 'red' : 'gray' }}
        >
          HOLD TO SPIN
        </button>
      )}
    </div>
  );
}
