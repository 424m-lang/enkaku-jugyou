import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';

// ファイル保存の抽象化。将来S3互換ストレージへ差し替える場合はここを変更する

/** パスを組み立てるだけ。無ければ作る lessonDir() と違い、削除のときに使う */
export function lessonDirPath(lessonId: string): string {
  return path.join(config.dataDir, 'lessons', lessonId);
}

export function lessonDir(lessonId: string): string {
  const dir = lessonDirPath(lessonId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pdfPath(lessonId: string): string {
  return path.join(lessonDir(lessonId), 'slides.pdf');
}

export function audioPath(lessonId: string): string {
  return path.join(lessonDir(lessonId), 'audio.webm');
}

export function clipPath(lessonId: string, startMs: number, endMs: number): string {
  return path.join(lessonDir(lessonId), `clip_${startMs}_${endMs}.webm`);
}
