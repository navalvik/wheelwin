import { useState, useEffect } from 'react';
import { useTonConnect } from './hooks/useTonConnect';
import { useWebSocket } from './hooks/useWebSocket';
import RouletteGame from './components/RouletteGame';

function App() {
  const { wallet, connect, disconnect } = useTonConnect();
  const [baseBet, setBaseBet] = useState<1 | 10>(1);
  const [roomId, setRoomId] = useState<string | null>(null);
  const { gameState, sendJoinRoom, sendSelectSector, sendConfirmPayment, sendReady, sendButtonToggle } = useWebSocket();

  const handleCreateOrJoin = () => {
    if (!wallet) return;
    const playerId = wallet.account.address;
    sendJoinRoom(roomId ?? undefined, playerId, wallet.account.address, baseBet);
  };

  if (!wallet) {
    return (
      <div className="container">
        <h1>TON Multiplayer Roulette</h1>
        <button onClick={connect}>Connect TON Wallet</button>
        <div>
          <label>Base Bet: </label>
          <select value={baseBet} onChange={e => setBaseBet(Number(e.target.value) as 1 | 10)}>
            <option value={1}>1 TON</option>
            <option value={10}>10 TON</option>
          </select>
        </div>
      </div>
    );
  }

  if (!gameState) {
    return <button onClick={handleCreateOrJoin}>Create / Join Room</button>;
  }

  return (
    <RouletteGame
      gameState={gameState}
      playerWallet={wallet.account.address}
      onSelectSector={sendSelectSector}
      onConfirmPayment={sendConfirmPayment}
      onReady={sendReady}
      onButtonToggle={sendButtonToggle}
    />
  );
}

export default App;
