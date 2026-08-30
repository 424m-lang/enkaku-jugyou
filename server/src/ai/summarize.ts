import { config } from '../config';
import type { CommentInsightDetails } from '@shared';

async function callClaude(system: string, user: string, maxTokens: number): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const res = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content
    .filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function callOpenAI(system: string, user: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openaiModel,
      // GPT-5系は max_tokens を受け付けない（max_completion_tokens に統一されている）。
      // この上限は推論トークンも含むので、出力したい長さより余裕を持たせること
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API エラー: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return (data.choices[0]?.message.content ?? '').trim();
}

/** 日本語（ひらがな・カタカナ・漢字）が1文字でもあるか */
const JAPANESE_CHAR = /[\u3040-\u30FF\u3400-\u9FFF\uFF66-\uFF9F]/;

/**
 * 要約の文末にくっついた、意味のない断片を落とす。
 *
 * 実際に「…3か所で遅延が生じます。 tekreplawsalt」という出力が先生の画面に出た。
 * LLMはまれに無関係なトークンを生成することがあり、そのまま表示すると
 * 異常な出力と受け取られる可能性がある。
 *
 * 判定は**控えめ**にしてある。行ごとに見て、最後の「。」より後ろに
 * 日本語が1文字も無い断片が残っている場合だけ落とす。
 *
 * - 「…です。」            → そのまま（余りが無い）
 * - 「…です。 tekrepl」    → 「…です。」に切り詰める
 * - 「…はHTTPです。」      → そのまま（「。」で終わっている）
 * - 「12」「はい」          → そのまま（「。」が無い。発言の特定や同一判定の答えを壊さない）
 * - 「表題\n説明です。」    → 行ごとなので、表題の行は触らない
 *
 * 文の途中に含まれる断片は対象にしない。本文の意味を変える削除を避けるため、
 * 対象をこの範囲に限定している。削除した場合はログへ記録し、発生状況を確認できるようにする。
 */
export function stripTrailingNoise(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const end = line.lastIndexOf('。');
      if (end < 0) return line;
      const tail = line.slice(end + 1);
      if (tail.trim() === '' || JAPANESE_CHAR.test(tail)) return line;
      console.warn('[summarize] 要約の末尾から意味のない断片を落としました:', JSON.stringify(tail));
      return line.slice(0, end + 1);
    })
    .join('\n');
}

/** 設定されたプロバイダで要約LLMを呼ぶ。戻り値の第2要素は表示用のプロバイダ名 */
async function callSummaryLLM(
  system: string,
  user: string,
  maxTokens: number,
  rawJson = false
): Promise<{ text: string; provider: string } | null> {
  if (config.summaryProvider === 'anthropic' && config.anthropicApiKey) {
    return {
      text: rawJson
        ? await callClaude(system, user, maxTokens)
        : stripTrailingNoise(await callClaude(system, user, maxTokens)),
      provider: 'anthropic',
    };
  }
  if (config.summaryProvider === 'openai' && config.openaiApiKey) {
    return {
      text: rawJson
        ? await callOpenAI(system, user, maxTokens)
        : stripTrailingNoise(await callOpenAI(system, user, maxTokens)),
      provider: 'openai',
    };
  }
  return null; // mock にフォールバック
}

/** コメントに関連する説明を授業内から特定できない場合の定型文 */
export const TOPIC_NOT_COVERED_MESSAGE = '関連する説明を確認できませんでした。';

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function detailValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, 180);
  return text || null;
}

/**
 * 生徒コメントを、先生が短時間で確認できる5項目へ整理する。
 * 先生への助言は作らず、コメント原文と授業内の説明から
 * 確認できる情報だけを返す。該当しない項目は null とする。
 */
export async function analyzeCommentForTeacher(
  transcriptText: string,
  comments: string[],
  relatedExplanationFound: boolean
): Promise<CommentInsightDetails> {
  const result = await callSummaryLLM(
    [
      'あなたは、授業中に届いた生徒コメントを先生が短時間で確認できる形に整理します。',
      '返す項目は次の5つです。該当しない項目には null を入れてください。',
      '- relatedExplanation: コメントに関係し、先生がすでに説明した内容',
      '- unconfirmedPoint: コメントで尋ねられたうち、先生の説明から確認できない内容',
      '- outsideLesson: 授業の内容との関係を確認できない質問',
      '- trouble: 音が聞こえない、画面が見えない、操作できないなどの受講上の支障',
      '- feedback: 質問ではない意見または感想',
      '',
      '書き方:',
      '- 各値は60文字程度までの簡潔な内容にします。分類名は値に繰り返しません。',
      '- 先生への提案、指示、評価は書きません。「確認が必要です」「〜してください」などは使用しません。',
      '- コメント原文に無い困りごとや感情を推測しません。',
      '- 先生の説明に無い知識を補いません。',
      '- relatedExplanationFound が false の場合、relatedExplanation は必ず null にします。',
      '- outsideLesson は、コメント自体から授業外の話題だと明確に分かる場合だけ使用します。判断できない場合は unconfirmedPoint を使用します。',
      '- 1つのコメントが複数項目に該当する場合は、複数の値を入れて構いません。',
      '',
      'JSONオブジェクトだけを返してください。キーは relatedExplanation, unconfirmedPoint, outsideLesson, trouble, feedback の5つです。',
    ].join('\n'),
    `relatedExplanationFound: ${relatedExplanationFound}\n\n関連する説明:\n${transcriptText.slice(0, 30_000) || '(確認できませんでした)'}\n\n生徒のコメント:\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    900,
    true
  );
  if (result) {
    const parsed = parseJsonObject(result.text);
    if (parsed) {
      return {
        relatedExplanation: relatedExplanationFound
          ? detailValue(parsed.relatedExplanation)
          : null,
        unconfirmedPoint: detailValue(parsed.unconfirmedPoint),
        outsideLesson: detailValue(parsed.outsideLesson),
        trouble: detailValue(parsed.trouble),
        feedback: detailValue(parsed.feedback),
      };
    }
  }

  // モック環境では外部知識を補わず、原文から明確に確認できる項目だけを返す。
  const joined = comments.join(' / ').slice(0, 180);
  const trouble = /聞こえ|音が|見え|映ら|接続|つなが|止ま|固ま|操作でき|開けな/.test(joined)
    ? joined
    : null;
  const feedback = /分かりやす|わかりやす|よかった|良かった|難しかった|感想/.test(joined)
    ? joined
    : null;
  return {
    relatedExplanation: null,
    unconfirmedPoint: !trouble && !feedback ? TOPIC_NOT_COVERED_MESSAGE : null,
    outsideLesson: null,
    trouble,
    feedback,
  };
}

/**
 * 新しいコメントが既存カードのコメント群と同じ事柄への言及かを判定する。
 * LLMが使えない場合は null を返す（呼び出し側でヒューリスティックにフォールバック）。
 */
export async function judgeSameTopic(
  existingComments: string[],
  newComment: string
): Promise<boolean | null> {
  const result = await callSummaryLLM(
    'あなたは授業中の生徒コメントを整理するアシスタントです。既存のコメント群と新しいコメントが同じ事柄（同じ話題・同じ疑問）への言及かどうかを判定し、「yes」か「no」のみを出力してください。',
    `既存のコメント:\n${existingComments.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n新しいコメント:\n${newComment}`,
    200
  );
  if (!result) return null;
  return /yes/i.test(result.text);
}

/**
 * 授業後の「コメント」タブ: コメントの手前の文字起こし（時刻つきの細切れ）から、
 * そのコメントが先生のどの発言に向けられたものかを推定し、該当箇所の番号を返す。
 * LLMが使えない場合や判定できない場合は null（呼び出し側で暫定範囲にフォールバック）。
 */
export async function locateCommentTarget(
  segments: { startMs: number; endMs: number; text: string }[],
  comment: string
): Promise<number | null> {
  if (segments.length === 0) return null;
  const numbered = segments.map((s, i) => `${i + 1}. ${s.text.trim()}`).join('\n');
  const result = await callSummaryLLM(
    'あなたは授業の記録を分析するアシスタントです。番号付きの先生の発言（時系列）と、その後に生徒から届いたコメントを読み、コメントがどの発言について書かれたものかを推定してください。最も関連の深い発言の番号を、半角数字だけで出力してください。説明や記号は書かないでください。該当する発言が無い場合は 0 とだけ出力してください。',
    `先生の発言:\n${numbered.slice(0, 30_000)}\n\n生徒のコメント:\n${comment}`,
    200
  );
  if (!result) return null;
  const m = result.text.match(/\d+/);
  if (!m) return null;
  const idx = Number(m[0]) - 1;
  if (idx < 0 || idx >= segments.length) return null;
  return idx;
}

/** LLMの返答からJSON配列を取り出す（```json フェンスや前置きが付いても拾えるように） */
function parseJsonArray(raw: string): unknown[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type LessonBlock = {
  /** このブロックが始まる発言の番号（1始まり。渡した lines の並びに対応） */
  startNo: number;
  title: string;
  description: string;
};

/**
 * 復習動画: 授業全体をブロックに区分けする。
 * 先生の発言（時刻・表示スライド付き）とPDF各ページの本文をAIに渡し、
 * 話題の切れ目で区切らせる。区切りの数と長さはAIに任せる（一律の時間で割らない）。
 * それぞれのブロックだけを見ても内容が分かるよう、前提の説明を同じブロックに含めさせる。
 */
export async function segmentLessonIntoBlocks(
  lines: string[],
  slideOutline: string
): Promise<LessonBlock[] | null> {
  if (lines.length === 0) return null;
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const result = await callSummaryLLM(
    [
      'あなたは授業の録画を復習用に編集するアシスタントです。',
      '番号付きの先生の発言（時系列・表示中のスライド番号つき）と、スライドPDFの本文を読み、授業全体を話題のまとまりごとのブロックに区分けしてください。',
      '',
      '守ること:',
      '- 区切りは話題が切り替わる位置に置く。一定の時間で機械的に割らない。ブロックの数も長さもばらばらで構わない。',
      '- そのブロックだけを見た生徒が内容を理解できるようにする。前提となる説明や例題の導入は、それを使う説明と同じブロックに入れる。',
      '- 授業の最初から最後まで、すき間なく区分けする。最初のブロックは必ず1番の発言から始める。',
      '- 見出しは15文字以内。概要は、そのブロックで何をどう説明しているかが分かる2〜3文。',
      '- 概要は文字起こしとスライドに書かれている内容だけに基づいて書く。あなた自身の知識で話題を解説してはいけない。',
      '- 生徒の反応・評価・改善提案には一切触れない。',
      '',
      '出力はJSON配列だけを返してください。各要素は {"startNo": 発言番号, "title": "見出し", "description": "概要"} の形式です。',
    ].join('\n'),
    `スライドPDFの本文:
${slideOutline.slice(0, 20_000) || '(取得できませんでした)'}

先生の発言:
${numbered.slice(0, 90_000)}`,
    6000
  );
  if (!result) return null;
  const arr = parseJsonArray(result.text);
  if (!arr) return null;

  const blocks: LessonBlock[] = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const startNo = Number(o.startNo);
    if (!Number.isFinite(startNo) || startNo < 1 || startNo > lines.length) continue;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 40) : '';
    const description = typeof o.description === 'string' ? o.description.trim().slice(0, 400) : '';
    if (!title) continue;
    blocks.push({ startNo: Math.round(startNo), title, description });
  }
  if (blocks.length === 0) return null;

  // 昇順に整え、同じ位置から始まる重複を落とし、先頭は必ず授業の最初にする
  blocks.sort((a, b) => a.startNo - b.startNo);
  const deduped = blocks.filter((b, i) => i === 0 || b.startNo > blocks[i - 1].startNo);
  deduped[0].startNo = 1;
  return deduped;
}

/**
 * 復習動画の章: その区間の文字起こしから、見出しと一言説明を作る。
 * 生徒が見るページに出るため、誰がどう反応したかには一切触れさせない。
 */
export async function describeChapter(
  transcriptText: string
): Promise<{ title: string; description: string } | null> {
  const result = await callSummaryLLM(
    'あなたは授業の録画に見出しを付けるアシスタントです。渡された区間の文字起こしを読み、次の2行だけを日本語で出力してください。\n1行目: その区間の内容を表す15文字以内の見出し（記号や「見出し:」などのラベルは書かない）\n2行目: 何を説明している場面かの1文の説明\n生徒の反応・評価・提案には一切触れず、説明内容だけを書いてください。',
    transcriptText.slice(0, 20_000),
    600
  );
  if (!result) return null;
  const lines = result.text
    .split('\n')
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return { title: lines[0].slice(0, 40), description: lines[1] ?? '' };
}

/**
 * 授業後: 全体の文字起こしと反応集中箇所から、先生が全クリップを聞かなくても
 * 把握できる要約を作る（コメント分析と同じ要約処理を授業全体へ適用する）。
 */
export async function summarizeLesson(
  fullTranscript: string,
  clusterNotes: string[]
): Promise<{ text: string; provider: string }> {
  const result = await callSummaryLLM(
    'あなたは遠隔授業の記録を要約するアシスタントです。授業の文字起こしと、生徒の反応が集中した箇所の情報をもとに、日本語で以下の構成の要約を作成してください:\n## 授業の概要（3〜5文）\n## 生徒の反応が集中した箇所（箇条書きで、それぞれ何の説明中だったか・どんな反応か）\n## 次回への改善提案（2〜3項目）',
    `授業の文字起こし:\n${fullTranscript.slice(0, 100_000)}\n\n反応が集中した箇所:\n${clusterNotes.join('\n') || 'なし'}`,
    3000
  );
  if (result) return result;
  return {
    text: [
      '## 授業の概要（モック要約）',
      'SUMMARY_PROVIDER=anthropic または openai とAPIキーを設定すると、文字起こし全体からAIによる実際の要約が生成されます。',
      '',
      '## 生徒の反応が集中した箇所',
      ...clusterNotes.map((n) => `- ${n}`),
      '',
      '## 次回への改善提案',
      '- （モック）反応が集中した箇所の説明をより丁寧に行う',
    ].join('\n'),
    provider: 'mock',
  };
}
