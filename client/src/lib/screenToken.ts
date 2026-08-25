/**
 * 教室モニター用のトークン。
 *
 * 教室モニターは先生のPCとは別の端末（プロジェクタに繋いだ教室PC等）で開くため、
 * 先生のログインCookieも生徒の参加トークンも持っていない。
 * URLに入れたトークンを唯一の認証material として、表示に必要な読み取りだけを許す。
 *
 * 取り違えを防ぐため、スクリーンのページを開いているときだけ有効とみなす。
 */
export function screenTokenFromUrl(): string | null {
  if (!window.location.pathname.startsWith('/screen/')) return null;
  const token = new URLSearchParams(window.location.search).get('k');
  return token && token.length > 0 ? token : null;
}
