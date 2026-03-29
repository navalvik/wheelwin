import React, { useState, useEffect, useRef } from 'react';
import RouletteCanvas from './RouletteCanvas';
import './Screen3.css';

export default function Screen3({ roomState, socket, sendMessage }) {
  const [players, setPlayers] = useState([]);
  const [myPlayer, setMyPlayer] = useState(null);
  const [sectors, setSectors] = useState([]);
  const [gameState, setGameState] = useState(roomState?.state);
  const [speed, setSpeed] = useState(0);
  const [triangleSpeed, setTriangleSpeed] = useState(0);
  const [canControl, setCanControl] = useState(false);
  const [myButtonState, setMyButtonState] = useState(false);
  const [myPressedCount, setMyPressedCount] = useState(0);

  useEffect(() => {
    if (roomState) {
      setGameState(roomState.state);
      setSectors(roomState.sectors);
      setSpeed(roomState.speed);
      setTriangleSpeed(roomState.triangleSpeed);
      setPlayers(roomState.players);
      const me = roomState.players.find(p => p.id === socket.id);
      if (me) {
        setMyPlayer(me);
        setMyButtonState(me.buttonState);
        setMyPressedCount(me.pressedCount);
      }
      setCanControl(roomState.state === 'spin_phase' && roomState.controlPhaseActive);
    }
  }, [roomState, socket]);

  const handleSectorClick = (index) => {
    if (gameState === 'sector_assignment' && myPlayer && myPlayer.sectors.length === 0) {
      const wantSecond = window.confirm('Занять второй сектор? (доп. плата)');
      sendMessage('selectSector', { sectorIndex: index, wantSecond });
    }
  };

  const handleReady = () => {
    if (gameState === 'ready_phase' && !myPlayer?.ready) {
      sendMessage('playerReady');
    }
  };

  const handleButtonAction = () => {
    if (gameState === 'ready_phase' && myPlayer && !myPlayer.ready) {
      // Кнопка старт
      sendMessage('buttonAction');
    } else if (gameState === 'spin_phase' && canControl && myPressedCount < 2) {
      sendMessage('buttonAction');
    }
  };

  return (
    <div className="screen3">
      <div className="banner">Рекламный баннер</div>
      <div className="status-bar">
        {players.map(player => (
          <div key={player.id} className="player-status">
            <div className={`status-circle ${player.ready ? 'ready' : ''} ${player.buttonState ? 'pressed' : ''}`}></div>
            <span>{player.wallet.slice(0, 6)}</span>
          </div>
        ))}
      </div>
      <div className="game-area">
        <RouletteCanvas
          sectors={sectors}
          speed={speed}
          triangleSpeed={triangleSpeed}
          gameState={gameState}
          onSectorClick={handleSectorClick}
        />
        <button
          className={`center-button ${myButtonState ? 'active' : ''}`}
          onClick={handleButtonAction}
          disabled={!canControl && gameState !== 'ready_phase'}
        >
          {gameState === 'ready_phase' ? 'Готов' : gameState === 'spin_phase' ? (myButtonState ? 'Отжать' : 'Нажать') : '...'}
        </button>
      </div>
    </div>
  );
}
