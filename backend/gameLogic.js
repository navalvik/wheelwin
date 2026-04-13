export function calculateWinner(finalAngle, sectors) {
  const sectorAngle = (Math.PI * 2) / sectors.length;
  let idx = Math.floor(finalAngle / sectorAngle);
  if (idx >= sectors.length) idx = sectors.length - 1;
  return sectors[idx];
}

export function calculatePayout(pot, winnerId, playersMap) {
  if (!winnerId) return 0;
  const commission = pot * 0.05;
  const payout = pot - commission;
  return payout;
}
