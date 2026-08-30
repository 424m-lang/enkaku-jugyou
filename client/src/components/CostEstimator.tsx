import { useEffect, useMemo, useState } from 'react';
import type { LessonAiSettings } from '@shared';
import { DEFAULT_LESSON_AI_SETTINGS } from '@shared';
import { api } from '../lib/api';

type Style = 'school' | 'home' | 'mixed';

type CostRates = {
  fx: {
    usdJpy: number;
    roundedUsdJpy: number;
    source: 'boj' | 'fallback';
    rateDate: string | null;
  };
  rates: {
    asOf: string;
    render: {
      serverMonthlyUsd: number;
      diskMonthlyUsd: number;
      includedOutboundGb: number;
      outboundPerGbUsd: number;
    };
    openai: {
      whisperPerMinuteUsd: number;
      lunaInputPerMillionUsd: number;
      lunaOutputPerMillionUsd: number;
    };
  };
};

const FALLBACK: CostRates = {
  fx: { usdJpy: 155, roundedUsdJpy: 155, source: 'fallback', rateDate: null },
  rates: {
    asOf: '2026-08-30',
    render: {
      serverMonthlyUsd: 7,
      diskMonthlyUsd: 0.75,
      includedOutboundGb: 5,
      outboundPerGbUsd: 0.15,
    },
    openai: {
      whisperPerMinuteUsd: 0.006,
      lunaInputPerMillionUsd: 0.2,
      lunaOutputPerMillionUsd: 1.2,
    },
  },
};

function count(value: number, max = 10_000): number {
  return Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

function amount(value: number, max = 10_000): number {
  return Math.min(max, Math.max(0, Number.isFinite(value) ? value : 0));
}

function formatYen(value: number): string {
  return `${(Math.round(value / 10) * 10).toLocaleString('ja-JP')}円`;
}

export default function CostEstimator() {
  const [rates, setRates] = useState<CostRates>(FALLBACK);
  const [rateState, setRateState] = useState<'loading' | 'live' | 'fallback'>('loading');
  const [style, setStyle] = useState<Style>('school');
  const [durationMinutes, setDurationMinutes] = useState(50);
  const [lessonsPerMonth, setLessonsPerMonth] = useState(20);
  const [classrooms, setClassrooms] = useState(1);
  const [studentsPerClass, setStudentsPerClass] = useState(40);
  const [homeStudents, setHomeStudents] = useState(0);
  const [pdfMb, setPdfMb] = useState(5);
  const [videoReceivers, setVideoReceivers] = useState(0);
  const [commentsPerLesson, setCommentsPerLesson] = useState(10);
  const [features, setFeatures] = useState<LessonAiSettings>(DEFAULT_LESSON_AI_SETTINGS);

  useEffect(() => {
    let disposed = false;
    void api<CostRates>('/api/check/cost-rates')
      .then((value) => {
        if (disposed) return;
        setRates(value);
        setRateState(value.fx.source === 'boj' ? 'live' : 'fallback');
      })
      .catch(() => {
        if (!disposed) setRateState('fallback');
      });
    return () => {
      disposed = true;
    };
  }, []);

  const applyStyle = (next: Style) => {
    setStyle(next);
    if (next === 'school') {
      setClassrooms(1);
      setHomeStudents(0);
      setVideoReceivers(0);
    } else if (next === 'home') {
      setClassrooms(0);
      setHomeStudents(40);
      setVideoReceivers(0);
    } else {
      setClassrooms(1);
      setHomeStudents(20);
      setVideoReceivers(0);
    }
  };

  const result = useMemo(() => {
    const lessons = count(lessonsPerMonth, 500);
    const minutes = amount(durationMinutes, 600);
    const roomCount = count(classrooms, 100);
    const inSchool = roomCount * count(studentsPerClass, 200);
    const atHome = count(homeStudents, 10_000);
    const receivers = roomCount + atHome;
    const allBrowsers = inSchool + receivers + 1; // 生徒端末・教室モニター・先生端末
    const videoReceiverCount = count(videoReceivers, receivers);
    const audioOnlyReceiverCount = Math.max(0, receivers - videoReceiverCount);

    // 1GB=1000MBで料金側のGBへ合わせる。映像の約1Mbpsには音声も含む。
    const pdfGb = (amount(pdfMb, 500) * allBrowsers * lessons) / 1000;
    const audioGb = (32 * 60 * minutes * audioOnlyReceiverCount * lessons) / 8 / 1_000_000;
    const videoGb =
      (1_000 * 60 * minutes * videoReceiverCount * lessons) /
      8 /
      1_000_000;
    // 画面本体・ページ送り・書き込みなどの小さい通信を、端末1台・1コマ0.5MBで見込む。
    const controlGb = (0.5 * allBrowsers * lessons) / 1000;
    const needsTranscript = Object.values(features).some(Boolean);
    const usesRollingTranscript = features.commentAnalysis || features.whisperCaptionHistory;
    const transcriptMultiplier = usesRollingTranscript ? 1.05 : 1;
    // コメント時の追いつき処理では、1回につき最大15秒を文脈として重ねる。
    // 近い時刻のコメントでは重複実行を省くため、実額がこの計算を下回る場合がある。
    const commentOverlapMinutes = features.commentAnalysis
      ? count(commentsPerLesson, 500) * 0.25 * lessons
      : 0;
    const whisperMinutes = needsTranscript
      ? minutes * transcriptMultiplier * lessons + commentOverlapMinutes
      : 0;
    // RenderからWhisperへ送る16kHz・16bit・monoのWAVは1分あたり約1.92MB。
    const whisperUploadGb = (1.92 * whisperMinutes) / 1000;
    const outboundGb = pdfGb + audioGb + videoGb + controlGb + whisperUploadGb;

    const render = rates.rates.render;
    const fixedUsd = render.serverMonthlyUsd + render.diskMonthlyUsd;
    const bandwidthUsd = Math.max(0, outboundGb - render.includedOutboundGb) * render.outboundPerGbUsd;
    const whisperUsd = whisperMinutes * rates.rates.openai.whisperPerMinuteUsd;

    // 現在の処理1回あたりの入力・出力トークン数に幅を持たせ、表示中の単価から計算する。
    const luna = rates.rates.openai;
    const textRunUsd = (inputTokens: number, outputTokens: number) =>
      (inputTokens / 1_000_000) * luna.lunaInputPerMillionUsd +
      (outputTokens / 1_000_000) * luna.lunaOutputPerMillionUsd;
    const commentRuns = features.commentAnalysis ? count(commentsPerLesson, 500) * lessons : 0;
    const textLowUsd =
      commentRuns * textRunUsd(12_000, 400) +
      (features.lessonSummary ? lessons * textRunUsd(20_000, 800) : 0) +
      (features.reviewChapters ? lessons * textRunUsd(40_000, 1_700) : 0);
    const textHighUsd =
      commentRuns * textRunUsd(50_000, 1_700) +
      (features.lessonSummary ? lessons * textRunUsd(120_000, 5_000) : 0) +
      (features.reviewChapters ? lessons * textRunUsd(240_000, 10_000) : 0);

    const rate = rates.fx.roundedUsdJpy;
    const totalLowUsd = fixedUsd + bandwidthUsd + whisperUsd + textLowUsd;
    const totalHighUsd = fixedUsd + bandwidthUsd + whisperUsd + textHighUsd;
    return {
      roomCount,
      inSchool,
      atHome,
      receivers,
      allBrowsers,
      pdfGb,
      audioGb,
      videoGb,
      controlGb,
      whisperUploadGb,
      whisperMinutes,
      outboundGb,
      fixedYen: fixedUsd * rate,
      bandwidthYen: bandwidthUsd * rate,
      whisperYen: whisperUsd * rate,
      textLowYen: textLowUsd * rate,
      textHighYen: textHighUsd * rate,
      totalLowYen: totalLowUsd * rate,
      totalHighYen: totalHighUsd * rate,
      needsTranscript,
    };
  }, [
    classrooms,
    commentsPerLesson,
    durationMinutes,
    features,
    homeStudents,
    lessonsPerMonth,
    pdfMb,
    rates,
    studentsPerClass,
    videoReceivers,
  ]);

  return (
    <div className="check-page cost-estimator">
      <h1>料金の試算</h1>
      <p className="muted">
        授業の回数と受講方法から、現在のクラウド構成で1か月に発生する金額を試算します。
        この画面で機能を外しても、実際の授業設定は変わりません。
      </p>

      <section className="card cost-form">
        <h2>授業の条件</h2>
        <div className="cost-fields">
          <label>
            授業の受け方
            <select value={style} onChange={(event) => applyStyle(event.target.value as Style)}>
              <option value="school">学校の教室</option>
              <option value="home">各家庭</option>
              <option value="mixed">学校と各家庭</option>
            </select>
          </label>
          <label>
            1コマの長さ（分）
            <input type="number" min="1" max="600" value={durationMinutes} onChange={(e) => setDurationMinutes(amount(Number(e.target.value), 600))} />
          </label>
          <label>
            1か月のコマ数
            <input type="number" min="0" max="500" value={lessonsPerMonth} onChange={(e) => setLessonsPerMonth(count(Number(e.target.value), 500))} />
          </label>
          <label>
            教室数
            <input type="number" min="0" max="100" value={classrooms} onChange={(e) => setClassrooms(count(Number(e.target.value), 100))} />
          </label>
          <label>
            1教室の生徒数
            <input type="number" min="0" max="200" value={studentsPerClass} onChange={(e) => setStudentsPerClass(count(Number(e.target.value), 200))} />
          </label>
          <label>
            各家庭から受ける人数
            <input type="number" min="0" max="10000" value={homeStudents} onChange={(e) => setHomeStudents(count(Number(e.target.value)))} />
          </label>
          <label>
            PDFの大きさ（MB）
            <input type="number" min="0" max="500" step="0.5" value={pdfMb} onChange={(e) => setPdfMb(amount(Number(e.target.value), 500))} />
          </label>
          <label>
            カメラ映像を見る台数
            <input type="number" min="0" max={result.receivers} value={videoReceivers} onChange={(e) => setVideoReceivers(count(Number(e.target.value), result.receivers))} />
          </label>
          <label>
            1コマの生徒コメント数
            <input type="number" min="0" max="500" value={commentsPerLesson} onChange={(e) => setCommentsPerLesson(count(Number(e.target.value), 500))} />
          </label>
        </div>
        <p className="check-note">
          校内の生徒端末はスライドだけを受信し、音声は教室モニター{result.roomCount}台と各家庭の端末{result.atHome}台へ送る条件です。
        </p>
      </section>

      <section className="card cost-form">
        <h2>AI機能</h2>
        <div className="cost-ai-grid">
          {([
            ['commentAnalysis', '生徒コメントの整理'],
            ['whisperCaptionHistory', '字幕履歴の補正'],
            ['lessonSummary', '授業全体のAI要約'],
            ['reviewChapters', '復習動画の自動章分け'],
          ] as [keyof LessonAiSettings, string][]).map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={features[key]} onChange={(e) => setFeatures((prev) => ({ ...prev, [key]: e.target.checked }))} />
              {label}
            </label>
          ))}
        </div>
        <p className="check-note">
          授業後の要約と自動章分けは、選択している場合に毎回1回実行する条件で計算します。
        </p>
      </section>

      <section className="card cost-result">
        <h2>1か月の目安</h2>
        <div className="cost-total">
          <strong>
            {formatYen(result.totalLowYen)}
            {Math.round(result.totalHighYen / 10) !== Math.round(result.totalLowYen / 10) &&
              `〜${formatYen(result.totalHighYen)}`}
          </strong>
          <span>固定費、通信量、選択したAI機能の合計</span>
        </div>
        <table className="cost-table">
          <tbody>
            <tr><th>Render・永続ディスク</th><td>{formatYen(result.fixedYen)}</td></tr>
            <tr><th>外向き通信量</th><td>{result.outboundGb.toFixed(1)}GB ・ {formatYen(result.bandwidthYen)}</td></tr>
            <tr><th>Whisper</th><td>{result.needsTranscript ? formatYen(result.whisperYen) : '0円'}</td></tr>
            <tr>
              <th>文章を扱うAI</th>
              <td>
                {formatYen(result.textLowYen)}
                {Math.round(result.textHighYen / 10) !== Math.round(result.textLowYen / 10) &&
                  `〜${formatYen(result.textHighYen)}`}
              </td>
            </tr>
          </tbody>
        </table>
        <details className="cost-details">
          <summary>通信量の内訳</summary>
          <ul>
            <li>PDF {result.pdfGb.toFixed(1)}GB</li>
            <li>音声 {result.audioGb.toFixed(1)}GB</li>
            <li>カメラ映像 {result.videoGb.toFixed(1)}GB</li>
            <li>画面・ページ送り・書き込みなど {result.controlGb.toFixed(1)}GB</li>
            <li>Whisperへの音声送信 {result.whisperUploadGb.toFixed(1)}GB</li>
          </ul>
        </details>
        <p className="check-note">
          為替は1ドル{rates.fx.roundedUsdJpy}円（5円単位）で計算しています。
          {rateState === 'live'
            ? ` 日本銀行 ${rates.fx.rateDate} の値を使用しています。`
            : rateState === 'loading'
              ? ' 為替を取得しています。'
              : ' 為替を取得できなかったため、代替値を使用しています。'}
        </p>
        <p className="check-note">
          単価は{rates.rates.asOf}時点です。
          {result.needsTranscript && (
            <>
              無音と判定された文字起こし範囲は送信されないため、Whisperの実額が下がる場合があります。
              近い時刻のコメントでは重複処理を省くため、コメントに伴う文字起こしも試算より少なくなる場合があります。
            </>
          )}
          書き込み量、PDFの再読込、AIへ渡す文章量によって実額は変わります。
        </p>
      </section>
    </div>
  );
}
