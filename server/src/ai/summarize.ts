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
 * 授業中の振り返りタイム向け: 反応が集中した箇所の文字起こしから
 * 「今、力を入れて振り返るべき内容」の短い提案文を作る。
 */
export async function suggestReflectionFocus(
  transcriptText: string,
  info: { participantCount: number; kinds: Record<string, number>; comments: string[] }
): Promise<{ text: string; provider: string }> {
  const result = await callSummaryLLM(
    'あなたは遠隔授業を行う先生を支援するアシスタントです。生徒の理解度反応が集中した箇所の文字起こしを読み、先生への短い提案文を日本語で作成します。出力は2〜3文、話題の要約と「ここを重点的に振り返ることをお勧めします」という形の提案で締めてください。装飾や前置きは不要です。',
    `文字起こし（生徒${info.participantCount}人が反応した箇所）:\n${transcriptText}\n\n反応の内訳: ${JSON.stringify(info.kinds)}\n生徒のコメント: ${info.comments.join(' / ') || 'なし'}`,
    500
  );
  if (result) return result;
  return {
    text: `（モック提案）直近で${info.participantCount}人の反応が集中したのは、この文字起こし区間の内容です。ここを重点的に振り返ることをお勧めします。SUMMARY_PROVIDER=anthropic または openai とAPIキーを設定すると実際のAI提案になります。`,
    provider: 'mock',
  };
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
