import React, { useState, useEffect } from 'react';
import { GameProvider } from './context/GameContext';
import Screen1 from './components/Screen1';
import Screen2 from './components/Screen2';
import Screen3 from './components/Screen3';
import { useWebSocket } from './hooks/useWebSocket';
import { TonConnectUIProvider } from '@tonconnect/ui-react';

function App() {
  const [screen, setScreen] = useState(1);
  const { socket, roomState, sendMessage, isConnected } = useWebSocket();
  const [selectedBet, setSelectedBet] = useState(null);
  const [language, setLanguage] = useState('ru');

  useEffect(() => {
    if (roomState) {
      if (roomState.state === 'sector_assignment' || roomState.state === 'ready_phase' || roomState.state === 'spin_phase') {
        setScreen(3);
      } else if (roomState.state === 'waiting') {
        setScreen(2);
      }
    }
  }, [roomState]);

  const handleBetAndLanguageSelected = (bet, lang) => {
    setSelectedBet(bet);
    setLanguage(lang);
    // Переход к экрану комнат
    setScreen(2);
  };

  const handleRoomSelected = (roomId) => {
    // Подключение к комнате происходит через WebSocket
    sendMessage('createOrJoin', { betSize: selectedBet, language, walletAddress: 'TODO' });
  };

  return (
    <TonConnectUIProvider manifestUrl="https://yourdomain.com/tonconnect-manifest.json">
      <GameProvider>
        <div className="app">
          {screen === 1 && <Screen1 onNext={handleBetAndLanguageSelected} />}
          {screen === 2 && <Screen2 onRoomSelect={handleRoomSelected} socket={socket} />}
          {screen === 3 && <Screen3 roomState={roomState} socket={socket} sendMessage={sendMessage} />}
        </div>
      </GameProvider>
    </TonConnectUIProvider>
  );
}

export default App;
