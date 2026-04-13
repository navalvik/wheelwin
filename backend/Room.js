import { v4 as uuidv4 } from 'uuid';
import { calculateWinner, calculatePayout } from './gameLogic.js';

const PHASE_DURATIONS = {
  sector_selection: 30,   // секунд на выбор секторов
  payment: 60,
  ready: 0,               // ожидание ready от всех
  spinning: 0,            // длится пока игроки нажимают кнопку
  control: 5,
  deceleration: 3,
  result: 5
};

export default class Room {
  constructor(id, baseBet, io) {
    this.id = id;
    this.baseBet = baseBet; // 1 или 10 TON
    this.io = io;
    this.players = new Map(); // playerId -> Player
    this.state = 'waiting';   // waiting → sector_selection → payment → ready → spinning → control → deceleration → result
    this.sectors = this.initSectors(6); // 6 секторов, ownerId = null
    this.pot = 0;
    this.createdAt = Date.now();
    this.timer = null;
    this.currentSpeed = 0;
    this.currentAngle = 0;
    this.controlStartTime = 0;
    this.decelStartTime = 0;
    this.finalAngle = 0;
    this.winnerId = null;
    this.winningSectorId = null;
  }

  initSectors(count) {
    const sectors = [];
    for (let i = 0; i < count; i++) {
      sectors.push({ id: i, ownerId: null });
    }
    return sectors;
  }

  getPublicState() {
    return {
      id: this.id,
      baseBet: this.baseBet,
      state: this.state,
      pot: this.pot,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        wallet: p.wallet,
        status: p.status,
        sectors: p.sectors,
        isButtonPressed: p.isButtonPressed,
        toggleCount: p.toggleCount
      })),
      sectors: this.sectors,
      currentSpeed: this.currentSpeed,
      currentAngle: this.currentAngle,
      timer: this.timer ? Math.max(0, (this.timer.endTime - Date.now()) / 1000) : 0
    };
  }

  emitToRoom(event, data) {
    this.io.to(this.id).emit(event, data);
  }

  addPlayer(playerId, wallet) {
    if (this.players.size >= 3) return false;
    if (this.players.has(playerId)) return false;
    this.players.set(playerId, {
      id: playerId,
      wallet,
      status: 'idle',
      sectors: [],
      isButtonPressed: false,
      toggleCount: 0,
      paid: false,
      ready: false
    });
    if (this.players.size === 3 && this.state === 'waiting') {
      this.startSectorSelection();
    }
    return true;
  }

  startSectorSelection() {
    this.state = 'sector_selection';
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    this.startTimer(PHASE_DURATIONS.sector_selection, () => {
      // Автоматически перейти к payment, если не все выбрали
      this.finalizeSectorSelection();
    });
  }

  selectSector(playerId, sectorId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (this.state !== 'sector_selection') return;
    const sector = this.sectors.find(s => s.id === sectorId);
    if (!sector) return;
    if (sector.ownerId && sector.ownerId !== playerId) return;

    const currentSectors = player.sectors.length;
    let maxSectors = 2;
    let cost = currentSectors === 0 ? this.baseBet : this.baseBet * 2.5;

    if (currentSectors >= maxSectors) return;
    if (sector.ownerId === playerId) {
      // Убрать сектор
      player.sectors = player.sectors.filter(id => id !== sectorId);
      sector.ownerId = null;
    } else if (!sector.ownerId) {
      player.sectors.push(sectorId);
      sector.ownerId = playerId;
    }
    this.emitToRoom('ROOM_UPDATE', this.getPublicState());
  }

  finalizeSectorSelection() {
    // Если у игрока 0 секторов – назначить случайный? По ТЗ – минимум 1 сектор.
    for (let player of this.players.values()) {
      if (player.sectors.length === 0 && this.state === 'sector_selection') {
        // принудительно выбрать первый свободный сектор
        const freeSector = this.sectors.find(s => !s.ownerId);
        if (freeSector) {
          player.sectors.push(freeSector.id);
          freeSector.ownerId = player.id;
        }
      }
    }
    this.state = 'payment';
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    this.startTimer(PHASE_DURATIONS.payment, () => {
      this.startReadyPhase();
    });
  }

  async confirmPayment(playerId, txHash) {
    const player = this.players.get(playerId);
    if (!player || player.paid) return false;
    // Имитация проверки транзакции (в реальности вызов TON API)
    // Здесь предполагаем, что txHash валиден и сумма = стоимость секторов игрока
    const sectorCount = player.sectors.length;
    let amount = sectorCount === 1 ? this.baseBet : this.baseBet * 2.5;
    amount = amount * 1e9; // перевод в наноTON
    // Проверка: вызов TON Center API или walletService
    // Для демо просто считаем успешным
    player.paid = true;
    this.pot += amount / 1e9; // pot в TON
    // Проверяем, все ли заплатили
    const allPaid = Array.from(this.players.values()).every(p => p.paid);
    if (allPaid) {
      this.startReadyPhase();
    }
    return true;
  }

  startReadyPhase() {
    this.state = 'ready';
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    // Ждём нажатия READY от всех
    // ready будет отслеживаться через setPlayerReady
  }

  setPlayerReady(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.ready = true;
    const allReady = Array.from(this.players.values()).every(p => p.ready);
    if (allReady && this.state === 'ready') {
      this.startSpinningPhase();
    }
  }

  startSpinningPhase() {
    this.state = 'spinning';
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    // Ожидание первого BUTTON_TOGGLE = true
    // Реализуем через флаг
    this.spinStarted = false;
    // Таймаут на случай, если никто не нажмёт (10 сек)
    setTimeout(() => {
      if (this.state === 'spinning' && !this.spinStarted) {
        this.startControlPhase();
      }
    }, 10000);
  }

  handleButtonToggle(playerId, isPressed) {
    if (this.state !== 'spinning' && this.state !== 'control') return;
    const player = this.players.get(playerId);
    if (!player) return;
    if (isPressed && !player.isButtonPressed) {
      player.toggleCount++;
      if (player.toggleCount > 2) return; // ограничение
      player.isButtonPressed = true;
      if (!this.spinStarted && this.state === 'spinning') {
        this.spinStarted = true;
        this.startControlPhase();
      }
    } else if (!isPressed) {
      player.isButtonPressed = false;
    }
    // Обновляем скорость в фазе control
    if (this.state === 'control') {
      this.updateSpeed();
    }
  }

  startControlPhase() {
    this.state = 'control';
    this.controlStartTime = Date.now();
    this.updateSpeed();
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    this.timer = setTimeout(() => {
      this.startDecelerationPhase();
    }, PHASE_DURATIONS.control * 1000);
    // отправляем обновления скорости каждые 50 мс
    this.controlInterval = setInterval(() => {
      if (this.state === 'control') {
        this.currentAngle = (this.currentAngle + this.currentSpeed * 0.05) % (Math.PI * 2);
        this.emitToRoom('SPIN_UPDATE', { speed: this.currentSpeed, angle: this.currentAngle });
      }
    }, 50);
  }

  updateSpeed() {
    const pressedCount = Array.from(this.players.values()).filter(p => p.isButtonPressed).length;
    this.currentSpeed = 1 + pressedCount; // базовая скорость 1 + кол-во нажавших
  }

  startDecelerationPhase() {
    clearInterval(this.controlInterval);
    this.state = 'deceleration';
    this.decelStartTime = Date.now();
    this.startSpeed = this.currentSpeed;
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    const startAngle = this.currentAngle;
    const decDuration = PHASE_DURATIONS.deceleration; // 3 сек
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      let t = Math.min(1, elapsed / decDuration);
      // линейное замедление
      this.currentSpeed = this.startSpeed * (1 - t);
      this.currentAngle = startAngle + this.startSpeed * decDuration * (t - 0.5 * t * t);
      this.currentAngle = this.currentAngle % (Math.PI * 2);
      this.emitToRoom('SPIN_UPDATE', { speed: this.currentSpeed, angle: this.currentAngle });
      if (t >= 1) {
        clearInterval(interval);
        this.finalAngle = this.currentAngle;
        this.determineWinner();
      }
    }, 50);
  }

  determineWinner() {
    const sectorAngle = (Math.PI * 2) / this.sectors.length;
    let rawSector = Math.floor(this.finalAngle / sectorAngle);
    // добавляем случайный offset, чтобы избежать границ
    const offset = (Math.random() - 0.5) * 0.2;
    let adjustedAngle = this.finalAngle + offset;
    if (adjustedAngle < 0) adjustedAngle += Math.PI * 2;
    let winnerSectorId = Math.floor(adjustedAngle / sectorAngle) % this.sectors.length;
    const winnerSector = this.sectors[winnerSectorId];
    this.winningSectorId = winnerSector.id;
    this.winnerId = winnerSector.ownerId;
    this.state = 'result';
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    const payout = calculatePayout(this.pot, this.winnerId, this.players);
    this.emitToRoom('RESULT', { winnerId: this.winnerId, sectorId: this.winningSectorId, payout });
    // Инициировать выплату победителю (через walletService)
    if (this.winnerId) {
      // в реальности вызвать TON transfer
      console.log(`Pay ${payout} TON to ${this.winnerId}`);
    }
    // Через 5 сек перезапустить комнату или вернуть в waiting
    setTimeout(() => this.resetRoom(), 5000);
  }

  resetRoom() {
    this.players.clear();
    this.sectors = this.initSectors(6);
    this.pot = 0;
    this.state = 'waiting';
    this.currentSpeed = 0;
    this.currentAngle = 0;
    this.emitToRoom('GAME_STATE_CHANGED', this.state);
    this.emitToRoom('ROOM_UPDATE', this.getPublicState());
  }

  startTimer(durationSec, onEnd) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(onEnd, durationSec * 1000);
    // для UI отправляем обратный отсчёт
    const endTime = Date.now() + durationSec * 1000;
    const interval = setInterval(() => {
      const remaining = Math.max(0, (endTime - Date.now()) / 1000);
      this.emitToRoom('TIMER_UPDATE', remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 200);
  }
}
