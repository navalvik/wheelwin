import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import Room from './Room.js';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// Хранилище комнат: roomId -> Room
const rooms = new Map();

// Вспомогательные функции
function getRoom(roomId) {
  return rooms.get(roomId);
}

function createRoom(baseBet, playerId, wallet) {
  const roomId = uuidv4().slice(0, 8);
  const room = new Room(roomId, baseBet, io);
  room.addPlayer(playerId, wallet);
  rooms.set(roomId, room);
  return room;
}

// WebSocket подключение
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('JOIN_ROOM', ({ roomId, playerId, wallet, baseBet }) => {
    let room = getRoom(roomId);
    if (!room) {
      if (!baseBet) return;
      room = createRoom(baseBet, playerId, wallet);
      socket.emit('ROOM_CREATED', { roomId: room.id });
    } else {
      const success = room.addPlayer(playerId, wallet);
      if (!success) {
        socket.emit('ERROR', { message: 'Room full or already joined' });
        return;
      }
    }
    socket.join(room.id);
    room.emitToRoom('ROOM_UPDATE', room.getPublicState());
    socket.emit('GAME_STATE_CHANGED', room.state);
  });

  socket.on('SELECT_SECTOR', ({ roomId, playerId, sectorId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.selectSector(playerId, sectorId);
    room.emitToRoom('ROOM_UPDATE', room.getPublicState());
  });

  socket.on('CONFIRM_PAYMENT', async ({ roomId, playerId, txHash }) => {
    const room = getRoom(roomId);
    if (!room) return;
    // В реальном проекте: проверить txHash в TON blockchain
    // Здесь имитация успешной проверки
    const success = await room.confirmPayment(playerId, txHash);
    if (success) {
      room.emitToRoom('ROOM_UPDATE', room.getPublicState());
    } else {
      socket.emit('ERROR', { message: 'Payment verification failed' });
    }
  });

  socket.on('READY', ({ roomId, playerId }) => {
    const room = getRoom(roomId);
    if (room) {
      room.setPlayerReady(playerId);
      room.emitToRoom('ROOM_UPDATE', room.getPublicState());
    }
  });

  socket.on('BUTTON_TOGGLE', ({ roomId, playerId, state }) => {
    const room = getRoom(roomId);
    if (room && room.state === 'control') {
      room.handleButtonToggle(playerId, state);
      room.emitToRoom('SPIN_UPDATE', { speed: room.currentSpeed, angle: room.currentAngle });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Опционально: пометить игрока как disconnected, но не удалять
  });
});

httpServer.listen(3001, () => {
  console.log('Server running on http://localhost:3001');
});
