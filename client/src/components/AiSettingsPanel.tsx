import type { LessonAiSettings, LessonStatus } from '@shared';

type Props = {
  settings: LessonAiSettings;
  status: LessonStatus;
  onChange: (settings: LessonAiSettings) => void;
};

const ITEMS: {
  key: keyof LessonAiSettings;
  label: string;
  description: string;
  timing: string;
}[] = [
  {
    key: 'commentAnalysis',
    label: '生徒コメントの整理',
    description: 'コメントを5項目に整理し、関係する説明を表示します。',
    timing: 'コメントが届いたときに使用',
  },
  {
    key: 'whisperCaptionHistory',
    label: '字幕履歴の補正',
    description: '読み返す字幕を、Whisperの文字起こしで補正します。',
    timing: '授業中に定期的に使用',
  },
  {
    key: 'lessonSummary',
    label: '授業全体のAI要約',
    description: '授業終了後に、録音と反応から要約を作成できます。',
    timing: '授業後に要約を作成したときだけ使用',
  },
  {
    key: 'reviewChapters',
    label: '復習動画の自動章分け',
    description: '録音とスライドから、復習用の区切りと見出しを作成できます。',
    timing: '授業後に自動章分けを実行したときだけ使用',
  },
];

export default function AiSettingsPanel({ settings, status, onChange }: Props) {
  const editable = status === 'draft';
  return (
    <div className="ai-settings-panel">
      <p className="muted small">
        この授業で使用する機能を選びます。授業開始後は変更できません。
      </p>
      <div className="ai-settings-list">
        {ITEMS.map((item) => (
          <label key={item.key} className="ai-setting-row">
            <input
              type="checkbox"
              checked={settings[item.key]}
              disabled={!editable}
              onChange={(event) => onChange({ ...settings, [item.key]: event.target.checked })}
            />
            <span>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
              <small>{item.timing}</small>
            </span>
          </label>
        ))}
      </div>
      {!editable && <p className="check-note">この授業の設定は確定しています。</p>}
    </div>
  );
}
