import { processPayout, refundPayment } from './tonService.js';

export class GameRoom {
  constructor(id, betSize, io) {
    this.id = id;
    this.betSize = betSize; // 1 или 10
    this.io = io;
    this.maxPlayers = 5; // можно варьировать 3-5, пока жёстко 5
    this.players = [];     // объекты игроков
    this.state = 'waiting'; // waiting, sector_assignment, ready_phase, spin_phase, braking, finished
    this.sectors = [];     // массив секторов: каждый содержит ownerId или null
    this.totalSectors = 0; // вычисляется из ставок игроков (каждый игрок 1 или 2 сектора)
    this.winnerId = null;
    this.spinStartTime = null;
    this.speed = 0;        // текущая скорость вращения (об/сек)
    this.triangleSpeed = 0;
    this.brakingStartTime = null;
    this.timers = [];
  }

  getState() {
    return {
      id: this.id,
      state: this.state,
      players: this.players.map(p => ({
        id: p.id,
        wallet: p.wallet,
        language: p.language,
        sectors: p.sectors,
        ready: p.ready,
        buttonState: p.buttonState,
        pressedCount: p.pressedCount
      })),
      sectors: this.sectors,
      totalSectors: this.totalSectors,
      winnerId: this.winnerId,
      speed: this.speed,
      triangleSpeed: this.triangleSpeed,
      betSize: this.betSize
    };
  }

  getPlayersList() {
    return this.players.map(p => ({
      id: p.id,
      wallet: p.wallet,
      ready: p.ready,
      buttonState: p.buttonState,
      pressedCount: p.pressedCount,
      sectors: p.sectors,
      // для отображения статуса (цвет кружка)
    }));
  }

  addPlayer(player) {
    if (this.players.length >= this.maxPlayers) throw new Error('Room full');
    this.players.push(player);
  }

  removePlayer(playerId) {
    const index = this.players.findIndex(p => p.id === playerId);
    if (index !== -1) {
      const player = this.players[index];
      // Если уже были заняты сектора, освобождаем их
      if (player.sectors.length) {
        player.sectors.forEach(sectorIdx => {
          if (this.sectors[sectorIdx]) this.sectors[sectorIdx].ownerId = null;
        });
      }
      this.players.splice(index, 1);
      // Если игра ещё не началась, возвращаем ставки
      if (this.state === 'waiting' || this.state === 'sector_assignment') {
        refundPayment(player.wallet, this.betSize);
        if (player.sectors.length === 2) {
          const extra = this.betSize === 1 ? 1.5 : 15;
          refundPayment(player.wallet, extra);
        }
      }
    }
  }

  async startSectorAssignment() {
    this.state = 'sector_assignment';
    // Вычисляем количество секторов: сумма секторов игроков (1 или 2)
    // пока неизвестно, сколько выберут, но нужно создать пустые сектора
    // Максимум: каждый игрок может взять 2 сектора -> максимум 2*maxPlayers
    this.totalSectors = this.players.length * 2; // временно
    this.sectors = new Array(this.totalSectors).fill(null).map(() => ({ ownerId: null, color: null }));
    // Уведомляем всех о начале выбора секторов
    this.io.to(this.id).emit('roomState', this.getState());
  }

  async selectSector(playerId, sectorIndex, wantSecond) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'Player not found' };
    if (this.state !== 'sector_assignment') return { success: false, error: 'Not in sector assignment phase' };
    if (player.sectors.length > 0) return { success: false, error: 'Already selected sectors' };
    if (sectorIndex < 0 || sectorIndex >= this.totalSectors) return { success: false, error: 'Invalid sector' };
    if (this.sectors[sectorIndex].ownerId !== null) return { success: false, error: 'Sector already taken' };

    // Проверка непрерывности, если wantSecond
    let sectorsToTake = [sectorIndex];
    if (wantSecond) {
      const secondIndex = sectorIndex + 1;
      if (secondIndex >= this.totalSectors) return { success: false, error: 'Second sector out of range' };
      if (this.sectors[secondIndex].ownerId !== null) return { success: false, error: 'Second sector already taken' };
      sectorsToTake.push(secondIndex);
      // Дополнительная оплата
      const extraAmount = this.betSize === 1 ? 1.5 : 15;
      const paid = await this.processPayment(player.wallet, extraAmount);
      if (!paid) return { success: false, error: 'Payment for second sector failed' };
    }

    // Занимаем сектора
    const color = this.getPlayerColor(playerId);
    for (let idx of sectorsToTake) {
      this.sectors[idx] = { ownerId: playerId, color };
    }
    player.sectors = sectorsToTake;
    return { success: true };
  }

  areAllSectorsTaken() {
    return this.sectors.every(s => s.ownerId !== null);
  }

  async startReadyPhase() {
    this.state = 'ready_phase';
    // Сбрасываем готовность всех
    this.players.forEach(p => {
      p.ready = false;
      p.buttonState = false;
      p.pressedCount = 0;
    });
    this.io.to(this.id).emit('roomState', this.getState());
    this.io.to(this.id).emit('playersUpdate', this.getPlayersList());
  }

  setPlayerReady(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) player.ready = true;
  }

  allPlayersReady() {
    return this.players.every(p => p.ready);
  }

  startSpinPhase() {
    this.state = 'spin_phase';
    this.spinStartTime = null; // будет установлен после первого нажатия
    this.speed = 0;
    this.triangleSpeed = 0;
    this.io.to(this.id).emit('roomState', this.getState());
    // Ждём первого нажатия
  }

  handleButtonPress(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return;

    if (this.state === 'ready_phase') {
      // Игрок нажимает "Старт" первый раз
      if (this.spinStartTime === null) {
        this.spinStartTime = Date.now();
        player.buttonState = true;
        player.pressedCount = 1;
        this.updateSpeed();
        this.startControlPhase();
        this.io.to(this.id).emit('playersUpdate', this.getPlayersList());
        this.io.to(this.id).emit('roomState', this.getState());
      }
    } else if (this.state === 'spin_phase' && this.controlPhaseActive) {
      // Управление скоростью
      if (player.pressedCount < 2) {
        player.buttonState = !player.buttonState;
        player.pressedCount++;
        this.updateSpeed();
        this.io.to(this.id).emit('playersUpdate', this.getPlayersList());
        this.io.to(this.id).emit('roomState', this.getState());
      }
    }
  }

  updateSpeed() {
    const pressedCount = this.players.filter(p => p.buttonState).length;
    // Формула: скорость = 2^(pressedCount-1) об/с, но с ограничением
    let speed = Math.pow(2, pressedCount - 1);
    if (this.players.length === 3 && pressedCount === 3) speed = 4;
    if (this.players.length === 4 && pressedCount === 4) speed = 8;
    if (this.players.length === 5 && pressedCount === 5) speed = 16;
    if (pressedCount === 0) speed = 1;
    this.speed = speed;
    this.triangleSpeed = speed / 2; // противоположное направление
  }

  startControlPhase() {
    this.controlPhaseActive = true;
    // Таймер на 5 секунд
    const timer = setTimeout(() => {
      this.endControlPhase();
    }, 5000);
    this.timers.push(timer);
  }

  endControlPhase() {
    this.controlPhaseActive = false;
    // Блокируем кнопки
    this.players.forEach(p => {
      p.buttonState = false;
      p.pressedCount = 2; // чтобы больше не могли нажимать
    });
    this.state = 'braking';
    this.brakingStartTime = Date.now();
    this.brakingDuration = 3000; // 3 секунды
    this.io.to(this.id).emit('playersUpdate', this.getPlayersList());
    this.io.to(this.id).emit('roomState', this.getState());
    // Запускаем торможение
    this.startBraking();
  }

  startBraking() {
    const startSpeed = this.speed;
    const startTriangleSpeed = this.triangleSpeed;
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.brakingDuration) {
        clearInterval(interval);
        this.speed = 0;
        this.triangleSpeed = 0;
        this.determineWinner();
        return;
      }
      const t = elapsed / this.brakingDuration; // 0..1
      this.speed = startSpeed * (1 - t);
      this.triangleSpeed = startTriangleSpeed * (1 - t);
      this.io.to(this.id).emit('roomState', this.getState());
    }, 50);
    this.timers.push(interval);
  }

  determineWinner() {
    // Определяем сектор, на который указывает треугольник
    // В реальном коде нужно учитывать угловое положение секторов и треугольник.
    // Для простоты предположим, что треугольник всегда останавливается на каком-то секторе.
    // Здесь генерируем случайный сектор (демо).
    const randomSector = Math.floor(Math.random() * this.totalSectors);
    const winningSector = this.sectors[randomSector];
    if (winningSector) {
      this.winnerId = winningSector.ownerId;
      const winner = this.players.find(p => p.id === this.winnerId);
      if (winner) {
        // Выплата призового фонда
        const totalPot = this.calculateTotalPot();
        const ownerFee = totalPot * 0.05;
        const winnerAmount = totalPot * 0.95;
        processPayout(winner.wallet, winnerAmount);
        // Отправляем уведомление о победителе
        this.io.to(this.id).emit('gameResult', { winnerId: this.winnerId, winnerAmount });
      }
    }
    this.state = 'finished';
    this.io.to(this.id).emit('roomState', this.getState());
    // Очищаем таймеры
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
  }

  calculateTotalPot() {
    let total = 0;
    for (let p of this.players) {
      total += p.betSize;
      if (p.sectors.length === 2) {
        total += (p.betSize === 1 ? 1.5 : 15);
      }
    }
    return total;
  }

  async processPayment(wallet, amount) {
    // Здесь вызов TON Connect для списания средств
    // Возвращает true/false
    return true; // заглушка
  }

  getPlayerColor(playerId) {
    // Постоянные цвета для игроков (отличаются от серого, зелёного, жёлтого, красного)
    const colors = ['#FF4136', '#2ECC40', '#0074D9', '#FF851B', '#B10DC9'];
    const index = this.players.findIndex(p => p.id === playerId);
    return colors[index % colors.length];
  }
}
