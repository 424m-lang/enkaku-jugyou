/** 授業タイムライン上の経過ミリ秒を「分:秒」表記にする（例: 125000 → "2:05"） */
export function fmtClock(tMs: number): string {
  const s = Math.max(0, Math.floor(tMs / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
