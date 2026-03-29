import { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';

export function useWebSocket(url = 'http://localhost:3001') {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [roomState, setRoomState] = useState(null);
  const [players, setPlayers] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const newSocket = io(url);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('roomState', (state) => {
      setRoomState(state);
    });

    newSocket.on('playersUpdate', (playersList) => {
      setPlayers(playersList);
    });

    newSocket.on('gameResult', (result) => {
      // Обработка результата игры
      console.log('Game result:', result);
    });

    newSocket.on('error', (err) => {
      setError(err.message);
    });

    return () => {
      newSocket.close();
    };
  }, [url]);

  const sendMessage = (event, data) => {
    if (socket && isConnected) {
      socket.emit(event, data);
    }
  };

  return { socket, isConnected, roomState, players, error, sendMessage };
}
