import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AudioMode,
  CaptionLine,
  PointerPayload,
  PollAnswer,
  PollResults,
  PublicPoll,
} from '@shared';
import { applyTaskChange, visibleReactionButtons } from '@shared';
import { LiveAudioPlayer } from '../../lib/audio';
import { LiveVideoPlayer } from '../../lib/camera';
import { useWakeLock } from '../../lib/useWakeLock';
import { ReactionQueue } from '../../lib/reactionQueue';
import { useLessonLive } from '../../lib/useLessonLive';
import SlideCanvas from '../../components/SlideCanvas';
import TaskBar from '../../components/TaskBar';
import PollBar, { PollResultView } from '../../components/PollBar';
import CaptionBar from '../../components/CaptionBar';
import { readStored, writeStored } from '../../lib/storage';

/**
 * 音声チャンクがこの時間届かなければ「届いていない」と判断する。
 * チャンクは0.5秒ごとに来るので余裕はあるが、短すぎると一瞬の詰まりで
 * 警告が点滅して落ち着かないため、数秒待ってから出す。
 */
const AUDIO_STALL_MS = 5000;

/** ライブのバンドは直近しか出さないので、手元に持つ行数も少なくてよい */
const CAPTION_KEEP_LINES = 20;

/** 字幕を消したかどうかの記憶。端末ごとの好みなので授業を跨いで残す */
/**
 * この端末で字幕を出すか。既定はOFF。
 *
 * 先生に「生徒の端末に字幕を出す」というスイッチは無く、ここをONにすると
 * サーバ経由で先生の端末の音声認識が始まる。既定をONにすると、誰も読んでいないのに
 * 認識が回り続ける（＝先生の声が常に外の認識サービスへ送られる）ため、
 * 必ず本人が選んだときだけONにする。
 *
 * 以前の `captionsHidden`（既定＝表示）とは意味が逆なので、キーごと変えている
 */
const CAPTIONS_ON_KEY = 'captionsOn';
/** 先生の映像を閉じたか。閉じている間は配信そのものを止める */
const VIDEO_OFF_KEY = 'teacherVideoOff';
/** 映像の小窓の位置（0〜1の割合）。端末ごとに覚える */
const VIDEO_POS_KEY = 'teacherVideoPos';

/** 保存しておいた字幕の設定を読む（保存領域が使えない端末でも落ちない） */
function readCaptionsOn(): boolean {
  return readStored('local', CAPTIONS_ON_KEY) === '1';
}

export default function Class() {
  const navigate = useNavigate();
  const lessonId = readStored('session', 'lessonId');
  const hasToken = !!readStored('session', 'participantToken');

  const [pointer, setPointer] = useState<PointerPayload | null>(null);
  // 自動再生の制限があるため、一度は本人の操作で再生を始める必要がある
  const [audioEnabled, setAudioEnabled] = useState(false);
  // 先生が決めた、この端末で音を鳴らしてよいか（教室で受ける生徒は 'off'）
  const [audioAllowed, setAudioAllowed] = useState<AudioMode>('on');
  // この端末が先生の音声形式を再生できない場合。無音の原因が分かるように表に出す
  const [mediaUnsupported, setMediaUnsupported] = useState(false);
  // 音声を有効にしたのに届いていない状態
  const [audioStalled, setAudioStalled] = useState(false);
  const lastAudioAtRef = useRef<number | null>(null);
  // 自動字幕。出すかどうかは生徒が自分で決める。
  // 選んだ結果はこの端末に覚えさせる（読み込み直すたびに選び直させない）
  const [captionLines, setCaptionLines] = useState<{ tMs: number; text: string }[]>([]);
  const [captionInterim, setCaptionInterim] = useState('');
  const [captionsOn, setCaptionsOn] = useState(() => readCaptionsOn());
  // スライドを見ているだけの時間が長く、触らないので端末が自動ロックされやすい
  useWakeLock();
  const [videoLive, setVideoLive] = useState(false);
  // 先生が映像を送っているか（送っていないときは「出す」ボタンも出さない）
  const [videoOffered, setVideoOffered] = useState(false);
  const [videoOff, setVideoOff] = useState(() => readStored('local', VIDEO_OFF_KEY) === '1');
  // 小窓の位置。0=左上いっぱい、1=右下いっぱい。既定は右下
  const [videoPos, setVideoPos] = useState<{ x: number; y: number }>(() => {
    const raw = readStored('local', VIDEO_POS_KEY);
    if (!raw) return { x: 1, y: 1 };
    try {
      const v = JSON.parse(raw) as { x: number; y: number };
      if (typeof v?.x === 'number' && typeof v?.y === 'number') {
        return { x: Math.min(1, Math.max(0, v.x)), y: Math.min(1, Math.max(0, v.y)) };
      }
    } catch {
      /* 壊れていたら既定に戻す */
    }
    return { x: 1, y: 1 };
  });
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const videoDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [comment, setComment] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  // 自分が完了したタスク。他の生徒の進捗は届かない
  const [myTaskIds, setMyTaskIds] = useState<string[]>([]);
  // アンケート: 自分の回答と、先生が見せると決めたときだけ届く集計
  const [myAnswers, setMyAnswers] = useState<Record<string, PollAnswer>>({});
  const [revealed, setRevealed] = useState<{ poll: PublicPoll; results: PollResults } | null>(null);

  const audioElRef = useRef<HTMLAudioElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const videoPlayerRef = useRef<LiveVideoPlayer | null>(null);
  const queueRef = useRef<ReactionQueue | null>(null);
  // 締め切りのイベントには設問の中身が含まれないため、開いていた設問を控えておく
  const openPollRef = useRef<PublicPoll | null>(null);
  // コメントの対象スライド（入力を始めた時点のスライド。切替後に送っても正しく紐づく）
  const composeSlideRef = useRef<string | null>(null);
  const lastComposeSentRef = useRef(0);

  useEffect(() => {
    if (!lessonId || !hasToken) navigate('/join');
  }, [lessonId, hasToken, navigate]);

  const {
    socketRef,
    captionsUnavailable,
    connected,
    title,
    status,
    buttons,
    reactionsEnabled,
    currentSlideId,
    currentSlide,
    strokes,
    currentProgress,
    pdf,
    avHasAudio,
    tasks,
    taskMode,
    tasksActive,
    openPoll,
  } = useLessonLive(lessonId && hasToken ? lessonId : null, {
    setup: (socket) => {
      // 自分の進捗（再接続時もサーバの値で上書きされる）
      socket.on('my_task_progress', (p) => setMyTaskIds(p.taskIds));
      socket.on('my_poll_answer', (p) =>
        setMyAnswers((prev) => ({ ...prev, [p.pollId]: p.answer }))
      );
      // アンケートが始まったら、前に見せた集計は引っ込める
      socket.on('poll_open', () => setRevealed(null));
      // 集計が付いてくるのは、先生が「結果を見せる」を選んで締め切ったときだけ
      socket.on('poll_closed', (p) => {
        const poll = openPollRef.current;
        setRevealed(p.results && poll?.id === p.pollId ? { poll, results: p.results } : null);
      });
      // 締め切ったあとに先生が出し入れする集計（設問も一緒に届くので単体で表示できる）
      socket.on('poll_reveal', (p) => {
        setRevealed(p.poll && p.results ? { poll: p.poll, results: p.results } : null);
      });
      // 生徒画面だけが受け取るイベント
      queueRef.current = new ReactionQueue(lessonId!, socket);
      setQueuedCount(queueRef.current.pendingCount);
      if (audioElRef.current) {
        playerRef.current = new LiveAudioPlayer(audioElRef.current);
        playerRef.current.onUnsupported = () => setMediaUnsupported(true);
      }
      socket.on('connect_error', (err) => {
        // トークン失効などで認証できない場合は参加画面へ
        if (String(err.message).includes('認証')) navigate('/join');
      });
      socket.on('pointer', (p) => setPointer(p));
      socket.on('slide_change', () => setPointer(null));
      socket.on('audio_init', (chunk, _seq, mime) => {
        lastAudioAtRef.current = Date.now();
        playerRef.current?.reset(chunk, mime);
      });
      socket.on('audio_chunk', (chunk) => {
        lastAudioAtRef.current = Date.now();
        playerRef.current?.push(chunk);
      });
      socket.on('audio_permission', (p) => setAudioAllowed(p.audio));
      // 字幕の希望は接続ごとに送り直す。サーバは接続単位で数えていて、
      // 再接続すると前の申告は消えるため（端末を閉じた生徒のぶんで認識を回さないための作り）
      socket.on('connect', () => {
        if (readCaptionsOn()) socket.emit('set_my_captions', { on: true }, () => {});
      });
      socket.on('caption', (p) => {
        if (p.final) {
          setCaptionInterim('');
          setCaptionLines((prev) => [...prev, { tMs: p.tMs, text: p.text }].slice(-CAPTION_KEEP_LINES));
        } else {
          setCaptionInterim(p.text);
        }
      });

      // カメラ映像は、先生が「遠隔の生徒にも送る」を選んだときだけ届く
      // 再生できる形式かは init が届くまで分からないので、プレイヤーは先に作っておく
      if (videoElRef.current) {
        videoPlayerRef.current = new LiveVideoPlayer(videoElRef.current);
        videoPlayerRef.current.onUnsupported = () => setVideoLive(false);
      }
      socket.on('av_init', (chunk, _seq, mime) => {
        videoPlayerRef.current?.reset(chunk, mime);
        setVideoLive(true);
      });
      socket.on('av_chunk', (chunk) => videoPlayerRef.current?.push(chunk));
      socket.on('av_state', (p) => {
        const offered = p.cameraOn && p.videoToStudents;
        setVideoOffered(offered);
        if (!offered) setVideoLive(false);
      });
      // 閉じたままの状態は接続のたびに伝え直す（サーバは覚えていない）
      socket.on('connect', () => {
        if (readStored('local', VIDEO_OFF_KEY) === '1') {
          socket.emit('set_my_video', { on: false }, () => {});
        }
      });
    },
  });

  // 先生の端末で認識が始まる・止まるので、切り替えはサーバにも伝える
  const setCaptionsOnPersisted = useCallback(
    (on: boolean) => {
      setCaptionsOn(on);
      writeStored('local', CAPTIONS_ON_KEY, on ? '1' : '0');
      socketRef.current?.emit('set_my_captions', { on }, () => {});
    },
    [socketRef]
  );

  useEffect(() => {
    return () => {
      playerRef.current?.dispose();
      videoPlayerRef.current?.dispose();
    };
  }, []);

  /**
   * 先生の映像を受け取るかを切り替える。
   *
   * 「隠す」ではなく**受け取るのをやめる**。見ていない映像に毎秒900kbpsを
   * 使わせないため（回線の細い家庭ほど効く）
   */
  const setVideoOffPersisted = useCallback(
    (off: boolean) => {
      setVideoOff(off);
      writeStored('local', VIDEO_OFF_KEY, off ? '1' : '0');
      socketRef.current?.emit('set_my_video', { on: !off }, () => {});
      if (off) setVideoLive(false);
    },
    [socketRef]
  );

  // ---- 小窓の移動（この端末のなかだけの話なのでサーバへは送らない） ----
  const onVideoPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // ×は動かさない
    const box = videoBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    videoDragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくても動かせる */
    }
  }, []);

  const onVideoPointerMove = useCallback((e: React.PointerEvent) => {
    const d = videoDragRef.current;
    const box = videoBoxRef.current;
    const area = box?.parentElement?.getBoundingClientRect();
    if (!d || !box || !area) return;
    const rect = box.getBoundingClientRect();
    const availX = area.width - rect.width;
    const availY = area.height - rect.height;
    if (availX <= 0 || availY <= 0) return;
    const x = Math.min(1, Math.max(0, (e.clientX - d.dx - area.left) / availX));
    const y = Math.min(1, Math.max(0, (e.clientY - d.dy - area.top) / availY));
    setVideoPos({ x, y });
  }, []);

  const onVideoPointerUp = useCallback(() => {
    if (!videoDragRef.current) return;
    videoDragRef.current = null;
    setVideoPos((pos) => {
      writeStored('local', VIDEO_POS_KEY, JSON.stringify(pos));
      return pos;
    });
  }, []);

  // 履歴は開いたときだけ取りに行く（常時配るには量が多いため）
  const loadCaptionHistory = useCallback(
    () =>
      new Promise<CaptionLine[]>((resolve) => {
        const socket = socketRef.current;
        if (!socket) return resolve([]);
        socket.emit('get_captions', (res) => resolve(res.lines));
      }),
    [socketRef]
  );

  // ---- 音声が本当に届いているかの監視 ----
  // 先生のマイクが許可されなかった場合、先生画面には「マイクエラー」が出るが
  // 生徒側は無言のまま無音になり、原因が分からない。マイク不調でも通信の問題でも
  // 生徒にとっては同じ「届いていない」なので、受信が途切れたことをそのまま伝える。
  useEffect(() => {
    const watching = status === 'live' && audioAllowed === 'on' && audioEnabled && !mediaUnsupported;
    if (!watching) {
      setAudioStalled(false);
      return;
    }
    // 有効にした時点を起点にする（一度も届かない場合もここから数える）
    if (lastAudioAtRef.current === null) lastAudioAtRef.current = Date.now();
    const timer = setInterval(() => {
      const last = lastAudioAtRef.current;
      // 切断中は「再接続中...」が出ているので、そちらに任せて二重に出さない
      setAudioStalled(!!last && connected && Date.now() - last > AUDIO_STALL_MS);
    }, 1000);
    return () => clearInterval(timer);
  }, [status, audioAllowed, audioEnabled, mediaUnsupported, connected]);

  // 音声の出し分け。映像が届いているときは映像側の音を鳴らし、音声のみの
  // ストリームはミュートする（同じ声が二重に鳴らないように）。
  // 受信は両方続けるので、切り替えで音が途切れることはない。
  // 映像に音声が入っていない配信のときは、音声のみのストリームを鳴らし続ける
  useEffect(() => {
    const allowed = audioAllowed === 'on' && audioEnabled;
    const useAvAudio = videoLive && avHasAudio;
    if (audioElRef.current) audioElRef.current.muted = !allowed || useAvAudio;
    if (videoElRef.current) videoElRef.current.muted = !allowed || !useAvAudio;
  }, [audioAllowed, audioEnabled, videoLive, avHasAudio]);

  // 入力欄に文字がある間は「入力中」の合図を定期送信し続ける
  // （手が止まって考えている間もサーバ側の要約待ちが切れないように）
  useEffect(() => {
    if (!comment.trim()) return;
    const timer = setInterval(() => {
      const socket = socketRef.current;
      if (socket && composeSlideRef.current) {
        socket.emit('comment_composing', { slideId: composeSlideRef.current, active: true });
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [comment, socketRef]);

  const enableAudio = useCallback(() => {
    playerRef.current?.enable();
    videoPlayerRef.current?.enable();
    setAudioEnabled(true);
  }, []);

  const sendReaction = useCallback(
    async (kind: string, text?: string, slideId?: string) => {
      const q = queueRef.current;
      if (!q) return;
      const result = await q.send(kind, text, slideId ?? currentSlideId ?? undefined);
      setQueuedCount(q.pendingCount);
      setFlash(result === 'sent' ? '送信しました' : 'オフラインのため送信待ちに保存しました');
      setTimeout(() => setFlash(null), 1500);
    },
    [currentSlideId]
  );

  // コメント入力中の合図（入力中は数秒おきに送り、送信・クリアで解除）
  const onCommentChange = useCallback(
    (value: string) => {
      setComment(value);
      const socket = socketRef.current;
      if (!socket) return;
      if (value.trim()) {
        if (!composeSlideRef.current) composeSlideRef.current = currentSlideId;
        const now = Date.now();
        if (now - lastComposeSentRef.current > 4000 && composeSlideRef.current) {
          lastComposeSentRef.current = now;
          socket.emit('comment_composing', { slideId: composeSlideRef.current, active: true });
        }
      } else if (composeSlideRef.current) {
        socket.emit('comment_composing', { slideId: composeSlideRef.current, active: false });
        composeSlideRef.current = null;
        lastComposeSentRef.current = 0;
      }
    },
    [socketRef, currentSlideId]
  );

  const sendComment = useCallback(async () => {
    const text = comment.trim();
    if (!text) return;
    const slideId = composeSlideRef.current ?? currentSlideId ?? undefined;
    composeSlideRef.current = null;
    lastComposeSentRef.current = 0;
    setComment('');
    await sendReaction('comment', text, slideId);
  }, [comment, sendReaction, currentSlideId]);

  openPollRef.current = openPoll;

  const sendPollAnswer = useCallback(
    (p: { optionIds?: string[]; text?: string }) => {
      const pollId = openPollRef.current?.id;
      if (!pollId) return;
      socketRef.current?.emit('poll_answer', { pollId, ...p }, () => {});
    },
    [socketRef]
  );

  // タスクの完了・取り消し。押した瞬間に手元へ反映し、サーバの結果で上書きする
  // （順番通りモードの「前のタスクもまとめて完了」は同じ関数がサーバ側でも走る）
  const setTask = useCallback(
    (taskId: string, done: boolean) => {
      setMyTaskIds((prev) => applyTaskChange(tasks, prev, taskId, done, taskMode));
      socketRef.current?.emit('task_set', { taskId, done }, () => {});
    },
    [socketRef, tasks, taskMode]
  );

  // 先生が隠したボタンは出さない（定義は残るので、戻せばまた出る）
  const shownButtons = visibleReactionButtons(buttons);

  if (!lessonId) return null;

  return (
    <div className="class-page">
      <header className="app-header">
        <div className="header-left">
          <h1>{title || '授業'}</h1>
          {!connected && <span className="chip chip-offline">再接続中...</span>}
          {queuedCount > 0 && <span className="chip chip-queued">送信待ち {queuedCount}件</span>}
        </div>
        <div className="header-right">
          {status === 'live' && audioAllowed === 'off' && (
            <span className="chip chip-muted" title="先生の設定です">
              🔇 音声は教室のスピーカーから
            </span>
          )}
          {status === 'live' && audioAllowed === 'on' && mediaUnsupported && (
            <span className="chip chip-warn" title="この端末のブラウザが対応していません">
              ⚠ この端末では音声を再生できません
            </span>
          )}
          {status === 'live' && audioAllowed === 'on' && audioStalled && (
            <span className="chip chip-warn" title="先生のマイクか、通信の問題と思われます">
              ⚠ 先生の音声が届いていません
            </span>
          )}
          {status === 'live' && videoOffered && videoOff && (
            <button className="btn" onClick={() => setVideoOffPersisted(false)}>
              先生の映像を出す
            </button>
          )}
          {status === 'live' && !captionsOn && (
            <button className="btn" onClick={() => setCaptionsOnPersisted(true)}>
              字幕を出す
            </button>
          )}
          {status === 'live' && captionsOn && captionsUnavailable && (
            <span className="chip chip-warn" title="先生の端末が音声認識に対応していません">
              ⚠ 字幕を作れません
            </span>
          )}
          {status === 'live' && audioAllowed === 'on' && !audioEnabled && !mediaUnsupported && (
            <button className="btn primary" onClick={enableAudio}>
              🔊 音声を再生
            </button>
          )}
        </div>
      </header>

      {/* 縦向きは下、横向きは右へ操作をまとめる。横向きのスマホは高さが足りず、
          下に積むとスライドが潰れてしまうため（切り替えはCSSだけで行う） */}
      <div className="class-body">
        <div className="class-main">
        {status === 'draft' && (
          <div className="page-center">
            <p>授業の開始を待っています...</p>
          </div>
        )}
        {status === 'ended' && (
          <div className="page-center">
            <p>授業は終了しました。おつかれさまでした。</p>
          </div>
        )}
        {status === 'live' && (
          <SlideCanvas
            pdf={pdf}
            slide={currentSlide}
            strokes={currentSlideId ? (strokes[currentSlideId] ?? []) : []}
            progressStrokes={currentProgress}
            pointer={pointer && pointer.slideId === currentSlideId ? pointer : null}
          />
        )}
        {/* 先生のカメラ映像（実演を見せている間だけ届く）。要素は残したまま隠す */}
        {/* 映像が届くのは「遠隔で参加」の生徒だけ（サーバ側の条件と同じ）。
            教室で受ける設定に変わると配信は止まるが、それを知らせるイベントは無いので、
            音声の可否と同じ条件で隠す。でないと最後のコマが止まったまま残る。
            位置は生徒が自分で決める（黒板のどこが隠れると困るかは本人にしか分からない） */}
        <div
          ref={videoBoxRef}
          className={
            videoLive && status === 'live' && audioAllowed === 'on' && !videoOff
              ? 'class-video'
              : 'screen-hidden'
          }
          style={{ '--pip-x': videoPos.x, '--pip-y': videoPos.y } as React.CSSProperties}
          onPointerDown={onVideoPointerDown}
          onPointerMove={onVideoPointerMove}
          onPointerUp={onVideoPointerUp}
          onPointerCancel={onVideoPointerUp}
        >
          <video ref={videoElRef} className="class-video-el" playsInline autoPlay />
          <button
            type="button"
            className="class-video-close"
            onClick={() => setVideoOffPersisted(true)}
            title="先生の映像を閉じる（通信も止まります）"
          >
            ×
          </button>
        </div>
        {status === 'live' && captionsOn && (
          <CaptionBar
            lines={captionLines}
            interim={captionInterim}
            loadHistory={loadCaptionHistory}
            onHide={() => setCaptionsOnPersisted(false)}
          />
        )}
      </div>

        <footer className="reaction-bar">
        {flash && <div className="flash">{flash}</div>}
        {status === 'live' && tasksActive && (
          <TaskBar
            tasks={tasks}
            mode={taskMode}
            doneIds={myTaskIds}
            disabled={status !== 'live'}
            compact={!!openPoll || !!revealed}
            onSet={setTask}
          />
        )}
        {status === 'live' && openPoll && (
          <PollBar
            poll={openPoll}
            answer={myAnswers[openPoll.id] ?? null}
            disabled={status !== 'live'}
            onAnswer={sendPollAnswer}
          />
        )}
        {status === 'live' && !openPoll && revealed && (
          <PollResultView
            poll={revealed.poll}
            results={revealed.results}
            onClose={() => setRevealed(null)}
          />
        )}
        {/* ボタンを使わない授業では行ごと出さない（空の行が場所を取らないように） */}
        {reactionsEnabled && shownButtons.length > 0 && (
          <div className="reaction-buttons">
            {shownButtons.map((b) => (
              <button
                key={b.key}
                className="reaction-btn"
                style={{ background: b.color }}
                disabled={status !== 'live'}
                onClick={() => void sendReaction(b.key)}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
        <div className="comment-row">
          <input
            value={comment}
            onChange={(e) => onCommentChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendComment();
            }}
            placeholder="コメントを送る（例: ○○がわかりません）"
            maxLength={200}
            disabled={status !== 'live'}
          />
          <button
            className="btn primary"
            onClick={() => void sendComment()}
            disabled={status !== 'live' || !comment.trim()}
          >
            送信
          </button>
        </div>
        </footer>
      </div>

      {/* 音声再生用（非表示） */}
      <audio ref={audioElRef} style={{ display: 'none' }} />
    </div>
  );
}
