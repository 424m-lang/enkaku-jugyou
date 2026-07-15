// アプリアイコンの生成スクリプト
// client/public/icon.svg を元に、PWA用PNGとWindowsショートカット用ICOを作る
// 使い方: node scripts/generate-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svgPath = path.join(root, 'client', 'public', 'icon.svg');
const publicDir = path.join(root, 'client', 'public');

const svg = fs.readFileSync(svgPath);

async function png(size) {
  return sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();
}

// PWA・ファビコン用PNG
for (const size of [512, 192, 32]) {
  const buf = await png(size);
  fs.writeFileSync(path.join(publicDir, `icon-${size}.png`), buf);
  console.log(`icon-${size}.png (${buf.length} bytes)`);
}

// Windowsショートカット用ICO（256px PNGをICOコンテナに格納）
const png256 = await png(256);
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // 画像数
header.writeUInt8(0, 6); // 幅 (0 = 256)
header.writeUInt8(0, 7); // 高さ (0 = 256)
header.writeUInt8(0, 8); // パレット色数
header.writeUInt8(0, 9); // reserved
header.writeUInt16LE(1, 10); // カラープレーン
header.writeUInt16LE(32, 12); // ビット深度
header.writeUInt32LE(png256.length, 14); // データサイズ
header.writeUInt32LE(22, 18); // データオフセット
const icoPath = path.join(root, 'icon.ico');
fs.writeFileSync(icoPath, Buffer.concat([header, png256]));
console.log(`icon.ico (${png256.length + 22} bytes)`);
