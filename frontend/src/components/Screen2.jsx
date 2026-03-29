import React, { useEffect, useState } from 'react';
import './Screen2.css';

export default function Screen2({ onRoomSelect, socket }) {
  const [rooms, setRooms] = useState([]);

  useEffect(() => {
    // Получить список комнат от сервера
    if (socket) {
      socket.emit('getRooms');
      socket.on('roomsList', (roomsList) => {
        setRooms(roomsList);
      });
    }
    return () => {
      socket?.off('roomsList');
    };
  }, [socket]);

  const getRoomColor = (room) => {
    if (room.players.length === 0) return 'gray';
    if (room.players.length === room.maxPlayers) return 'black';
    return 'white';
  };

  return (
    <div className="screen2">
      <div className="banner">Рекламный баннер</div>
      <div className="rooms-grid">
        {rooms.map(room => (
          <div
            key={room.id}
            className={`room ${getRoomColor(room)}`}
            onClick={() => onRoomSelect(room.id)}
          >
            {room.players.length}/{room.maxPlayers}
          </div>
        ))}
      </div>
    </div>
  );
}
