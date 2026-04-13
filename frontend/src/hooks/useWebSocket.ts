import { useEffect, useState, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';

export function useWebSocket() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [gameState, setGameState] = useState<any>(null);

  useEffect(() => {
    const s = io('http://localhost:3001');
    setSocket(s);
    s.on('ROOM_UPDATE', (data) => {
      setGameState(prev => ({ ...prev, ...data }));
    });
    s.on('GAME_STATE_CHANGED', (state) => {
      setGameState(prev => ({ ...prev, state }));
    });
    s.on('TIMER_UPDATE', (timer) => {
      setGameState(prev => ({ ...prev, timer }));
    });
    s.on('SPIN_UPDATE', ({ speed, angle }) => {
      setGameState(prev => ({ ...prev, currentSpeed: speed, currentAngle: angle }));
    });
    s.on('RESULT', (result) => {
      alert(`Winner: ${result.winnerId}, Sector: ${result.sectorId}, Payout: ${result.payout} TON`);
    });
    return () => { s.disconnect(); };
  }, []);

  const sendJoinRoom = useCallback((roomId: string | undefined, playerId: string, wallet: string, baseBet: number) => {
    socket?.emit('JOIN_ROOM', { roomId, playerId, wallet, baseBet });
  }, [socket]);

  const sendSelectSector = useCallback((roomId: string, playerId: string, sectorId: number) => {
    socket?.emit('SELECT_SECTOR', { roomId, playerId, sectorId });
  }, [socket]);

  const sendConfirmPayment = useCallback((roomId: string, playerId: string, txHash: string) => {
    socket?.emit('CONFIRM_PAYMENT', { roomId, playerId, txHash });
  }, [socket]);

  const sendReady = useCallback((roomId: string, playerId: string) => {
    socket?.emit('READY', { roomId, playerId });
  }, [socket]);

  const sendButtonToggle = useCallback((roomId: string, playerId: string, state: boolean) => {
    socket?.emit('BUTTON_TOGGLE', { roomId, playerId, state });
  }, [socket]);

  return { gameState, sendJoinRoom, sendSelectSector, sendConfirmPayment, sendReady, sendButtonToggle };
}
