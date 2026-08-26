import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from './db';

/**
 * 名前を入れずに参加した生徒へ配る仮名（例: 「あおいネコ」「黄色いカワウソ」）。
 *
 * 「生徒1・生徒2」のような連番にしていないのは、**参加した順番が先生に見えてしまう**ため。
 * 早く来たか遅れて来たかは、この仕組みで扱う情報ではない。
 *
 * 色と動物の組み合わせにしたのは、順番を漏らさずに区別がつくから。
 * 先生が「さっきの赤いキツネの質問」と覚えていられる程度の手がかりは残しつつ、
 * 誰なのかは分からない、という水準に合わせてある。
 *
 * 仮名は **その授業の中だけ** で一貫する。同じ生徒でも次の授業では別の仮名になるので、
 * 授業をまたいで個人を追うことはできない。
 */

/** 語尾（「い」／「の」）まで含めて持つ。連結するだけで日本語として読めるようにするため */
const COLORS = [
  '赤い',
  '青い',
  '黄色い',
  '白い',
  '黒い',
  '茶色い',
  '緑の',
  '紫の',
  '桃色の',
  '橙色の',
  '水色の',
  '金色の',
  '銀色の',
  '灰色の',
] as const;

/** 見分けがつき、字面が短い動物を選んである（先生の画面で名前が折り返さない長さ） */
const ANIMALS = [
  'ネコ',
  'イヌ',
  'ウサギ',
  'キツネ',
  'タヌキ',
  'パンダ',
  'ゾウ',
  'キリン',
  'ライオン',
  'トラ',
  'リス',
  'ハリネズミ',
  'ペンギン',
  'フクロウ',
  'イルカ',
  'クジラ',
  'カメ',
  'カエル',
  'ハムスター',
  'アライグマ',
  'コアラ',
  'カワウソ',
  'シカ',
  'ヒツジ',
  'ヤギ',
  'ウマ',
  'アルパカ',
  'カピバラ',
  'ラッコ',
  'アザラシ',
] as const;

/** 組み合わせの総数。学年規模（数百人）を1授業で超えない限り、番号は付かない */
export const ANONYMOUS_NAME_COMBINATIONS = COLORS.length * ANIMALS.length;

/**
 * その授業でまだ使われていない仮名を1つ返す。
 *
 * 同時に参加した2人が同じ仮名を引く可能性はごく僅かに残る（DBに一意制約は置いていない。
 * 本名で参加する生徒に同姓同名がいてもよいため）。当たっても先生の画面に同じ名前が
 * 2つ並ぶだけで、参加者IDは別なので集計・重複排除には影響しない。
 */
export async function generateAnonymousName(lessonId: string): Promise<string> {
  const rows = await db
    .select({ displayName: schema.participants.displayName })
    .from(schema.participants)
    .where(eq(schema.participants.lessonId, lessonId));
  const used = new Set(rows.map((r) => r.displayName));

  // 空きの中からランダムに選ぶ。先頭から順に配ると「赤いネコ」「赤いイヌ」…と
  // 並んでしまい、結局そこから参加順が読めてしまう
  const free: string[] = [];
  for (const color of COLORS) {
    for (const animal of ANIMALS) {
      const name = color + animal;
      if (!used.has(name)) free.push(name);
    }
  }
  if (free.length > 0) return free[crypto.randomInt(free.length)];

  // 全通りを使い切ったときだけ、末尾に番号を足して延長する
  for (let n = 2; ; n++) {
    const name = `${COLORS[crypto.randomInt(COLORS.length)]}${ANIMALS[crypto.randomInt(ANIMALS.length)]}${n}`;
    if (!used.has(name)) return name;
  }
}
