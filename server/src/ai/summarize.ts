import { config } from '../config';

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
      max_tokens: maxTokens,
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

/** 設定されたプロバイダで要約LLMを呼ぶ。戻り値の第2要素は表示用のプロバイダ名 */
async function callSummaryLLM(
  system: string,
  user: string,
  maxTokens: number
): Promise<{ text: string; provider: string } | null> {
  if (config.summaryProvider === 'anthropic' && config.anthropicApiKey) {
    return { text: await callClaude(system, user, maxTokens), provider: 'anthropic' };
  }
  if (config.summaryProvider === 'openai' && config.openaiApiKey) {
    return { text: await callOpenAI(system, user, maxTokens), provider: 'openai' };
  }
  return null; // mock にフォールバック
}

/** コメントの内容を先生が授業で話していなかったときに表示する定型文 */
export const TOPIC_NOT_COVERED_MESSAGE = 'このコメントの内容について、先生は授業では話していません。';

/**
 * コメント・振り返り: 生徒のコメントと入力開始時刻周辺の音声の文字起こしから、
 * 「生徒が何についてコメントしようとしたのか」を割り出し、
 * その部分の先生の話の重要ポイントを端的に要約する。
 * 先生が文字起こしの中でその内容に触れていない場合は、AI自身の知識で解説せず、
 * 話していない旨だけを返す。
 */
export async function summarizeCommentContext(
  transcriptText: string,
  comments: string[]
): Promise<{ text: string; provider: string }> {
  const result = await callSummaryLLM(
    'あなたは授業中の生徒コメントを分析するアシスタントです。先生の説明音声の文字起こしと生徒のコメントを読み、コメントが先生の話のどの内容についてのものかを特定し、その部分の重要ポイントを日本語で1〜2文に端的に要約してください。要約は必ず文字起こしに書かれている先生の発言だけに基づいて書き、あなた自身の知識でコメントの話題を解説してはいけません。コメントの内容を先生が文字起こしの中で話していない場合は、要約を書かず「NOT_COVERED」とだけ出力してください。要約する場合は要約だけを書き、評価・提案・前置きは一切書かないでください。',
    `先生の説明（文字起こし）:\n${transcriptText.slice(0, 30_000)}\n\n生徒のコメント:\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    300
  );
  if (result) {
    if (/^[\s"'「]*NOT_COVERED/i.test(result.text)) {
      return { text: TOPIC_NOT_COVERED_MESSAGE, provider: result.provider };
    }
    return result;
  }
  return {
    text: '（モック要約）コメントに関連する説明の要約です。SUMMARY_PROVIDER=anthropic または openai とAPIキーを設定すると実際のAI要約になります。',
    provider: 'mock',
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
    8
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
    8
  );
  if (!result) return null;
  const m = result.text.match(/\d+/);
  if (!m) return null;
  const idx = Number(m[0]) - 1;
  if (idx < 0 || idx >= segments.length) return null;
  return idx;
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
    200
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
 * 把握できる要約を作る（振り返り提案と同じ仕組みを全体範囲に適用したもの）。
 */
export async function summarizeLesson(
  fullTranscript: string,
  clusterNotes: string[]
): Promise<{ text: string; provider: string }> {
  const result = await callSummaryLLM(
    'あなたは遠隔授業の記録を要約するアシスタントです。授業の文字起こしと、生徒の反応が集中した箇所の情報をもとに、日本語で以下の構成の要約を作成してください:\n## 授業の概要（3〜5文）\n## 生徒の反応が集中した箇所（箇条書きで、それぞれ何の説明中だったか・どんな反応か）\n## 次回への改善提案（2〜3項目）',
    `授業の文字起こし:\n${fullTranscript.slice(0, 100_000)}\n\n反応が集中した箇所:\n${clusterNotes.join('\n') || 'なし'}`,
    2000
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
