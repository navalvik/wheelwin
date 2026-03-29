import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { GameRoom } from './gameLogic.js';
import { verifyPayment, processPayout } from './tonService.js';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST']
  }
});

// Хранилище комнат: roomId -> GameRoom
const rooms = new Map();

// Вспомогательная функция для поиска свободной комнаты по ставке
function findRoomWithBet(betSize) {
  for (const [id, room] of rooms) {
    if (room.betSize === betSize && room.state === 'waiting' && room.players.length < room.maxPlayers) {
      return id;
    }
  }
  return null;
}

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  let currentRoomId = null;
  let playerId = null;

  socket.on('createOrJoin', async ({ betSize, language, walletAddress }) => {
    try {
      // Поиск комнаты с такой же ставкой
      let roomId = findRoomWithBet(betSize);
      if (!roomId) {
        // Создаём новую комнату
        roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const newRoom = new GameRoom(roomId, betSize, io);
        rooms.set(roomId, newRoom);
      }
      const room = rooms.get(roomId);
      playerId = socket.id;
      currentRoomId = roomId;

      // Проверка TON платежа за базовую ставку (должна быть подтверждена до входа)
      // Здесь предполагаем, что walletAddress уже подтверждён и средства списаны
      // В реальной интеграции нужно вызвать verifyPayment(walletAddress, betSize) и отклонить, если не оплачено
      const paymentOk = await verifyPayment(walletAddress, betSize);
      if (!paymentOk) {
        socket.emit('error', { message: 'Payment not verified' });
        return;
      }

      // Добавляем игрока
      const player = {
        id: playerId,
        wallet: walletAddress,
        language,
        betSize,
        sectors: [],
        ready: false,
        buttonState: false, // нажата ли кнопка управления
        pressedCount: 0,    // количество нажатий/отжатий (макс 2)
        lastButtonPressTime: 0
      };
      room.addPlayer(player);
      socket.join(roomId);

      // Отправляем текущее состояние комнаты новому игроку
      socket.emit('roomState', room.getState());

      // Оповещаем всех в комнате об обновлении
      io.to(roomId).emit('playersUpdate', room.getPlayersList());

      // Если комната заполнилась, переходим к распределению секторов
      if (room.players.length === room.maxPlayers) {
        await room.startSectorAssignment();
      }
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Выбор секторов
  socket.on('selectSector', async ({ sectorIndex, wantSecond }) => {
    const room = rooms.get(currentRoomId);
    if (!room) return;
    try {
      const result = await room.selectSector(playerId, sectorIndex, wantSecond);
      if (result.success) {
        // После выбора проверяем, все ли сектора заняты
        if (room.areAllSectorsTaken()) {
          // Переходим в фазу готовности
          await room.startReadyPhase();
        }
        io.to(currentRoomId).emit('roomState', room.getState());
      } else {
        socket.emit('error', { message: result.error });
      }
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'Sector selection failed' });
    }
  });

  // Подтверждение готовности
  socket.on('playerReady', () => {
    const room = rooms.get(currentRoomId);
    if (room && room.state === 'ready_phase') {
      room.setPlayerReady(playerId);
      io.to(currentRoomId).emit('playersUpdate', room.getPlayersList());
      if (room.allPlayersReady()) {
        room.startSpinPhase();
      }
    }
  });

  // Нажатие кнопки управления (для запуска вращения или изменения скорости)
  socket.on('buttonAction', () => {
    const room = rooms.get(currentRoomId);
    if (room) {
      room.handleButtonPress(playerId);
    }
  });

  // Отключение игрока
  socket.on('disconnect', async () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.removePlayer(playerId);
      if (room.players.length === 0) {
        rooms.delete(currentRoomId);
      } else {
        io.to(currentRoomId).emit('playersUpdate', room.getPlayersList());
        // Если игра не началась, возможно, нужно вернуть ставки
        if (room.state !== 'finished') {
          // Возврат средств игроку
          // Здесь нужно вызвать refund
        }
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
