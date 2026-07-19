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

/**
 * コメント・振り返り: 生徒のコメントと入力開始時刻周辺の音声の文字起こしから、
 * 「生徒が何についてコメントしようとしたのか」を割り出し、
 * その部分の先生の話の重要ポイントを端的に要約する。
 */
export async function summarizeCommentContext(
  transcriptText: string,
  comments: string[]
): Promise<{ text: string; provider: string }> {
  const result = await callSummaryLLM(
    'あなたは授業中の生徒コメントを分析するアシスタントです。先生の説明音声の文字起こしと生徒のコメントを読み、コメントが先生の話のどの内容についてのものかを特定し、その部分の重要ポイントを日本語で1〜2文に端的に要約してください。要約だけを書き、評価・提案・前置きは一切書かないでください。コメントに対応する説明が文字起こしに見当たらない場合は、文字起こし全体の要点を1文で書いてください。',
    `先生の説明（文字起こし）:\n${transcriptText.slice(0, 30_000)}\n\n生徒のコメント:\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    300
  );
  if (result) return result;
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
