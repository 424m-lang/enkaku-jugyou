import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import type { LessonSummary, PointerPayload } from '@shared';
import { api } from '../../lib/api';
import { LiveAudioPlayer } from '../../lib/audio';
import { LiveVideoPlayer } from '../../lib/camera';
import { screenTokenFromUrl } from '../../lib/screenToken';
import { useLessonLive } from '../../lib/useLessonLive';
import SlideCanvas from '../../components/SlideCanvas';

/**
 * 教室のスクリーン（大画面）に投影する表示専用ページ。
 *
 * プロジェクタに繋いだ教室の端末で開く想定なので、先生のログインは要らず、
 * URLのトークンだけで表示できる。教室ではこの1台だけが音を鳴らし、
 * 生徒の端末はミュートにしておく（同じ音が何台からも鳴ると反響するため）。
 *
 * 先生のPCの拡張ディスプレイへドラッグして使うこともできる（その場合はトークン不要）。
 */

/** 操作バーを自動で隠すまでの時間。投影中に不要なUIが映り込まないようにする */
const CONTROLS_HIDE_MS = 3_000;

export default function Screen() {
  const { id: lessonId } = useParams<{ id: string }>();
  const screenToken = screenTokenFromUrl() ?? undefined;

  const [pointer, setPointer] = useState<PointerPayload | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  // この端末のブラウザが先生の音声形式を再生できない場合の形式名（対応時は null）
  const [unsupportedAudio, setUnsupportedAudio] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [videoLive, setVideoLive] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const audioElRef = useRef<HTMLAudioElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const audioPlayerRef = useRef<LiveAudioPlayer | null>(null);
  const videoPlayerRef = useRef<LiveVideoPlayer | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    connected,
    title,
    status,
    currentSlideId,
    currentSlide,
    strokes,
    currentProgress,
    pdf,
    cameraOn,
    avHasAudio,
    screenLayout,
  } = useLessonLive(lessonId, {
    screenToken,
    setup: (socket) => {
      socket.on('pointer', (p) => setPointer(p));
      socket.on('slide_change', () => setPointer(null));

      if (audioElRef.current) {
        audioPlayerRef.current = new LiveAudioPlayer(audioElRef.current);
        // 教室のモニターが無音のまま放置されるのが最悪なので、必ず画面に出す
        audioPlayerRef.current.onUnsupported = (mime) => setUnsupportedAudio(mime);
      }
      socket.on('audio_init', (chunk, _seq, mime) => audioPlayerRef.current?.reset(chunk, mime));
      socket.on('audio_chunk', (chunk) => audioPlayerRef.current?.push(chunk));

      // 再生できる形式かは init が届くまで分からないので、プレイヤーは先に作っておく
      if (videoElRef.current) {
        videoPlayerRef.current = new LiveVideoPlayer(videoElRef.current);
        // 映像が駄目でも授業は続くので、映像だけ下ろしてスライドに切り替える
        videoPlayerRef.current.onUnsupported = () => setVideoLive(false);
      }
      socket.on('av_init', (chunk, _seq, mime) => {
        videoPlayerRef.current?.reset(chunk, mime);
        setVideoLive(true);
      });
      socket.on('av_chunk', (chunk) => videoPlayerRef.current?.push(chunk));
      socket.on('av_state', (p) => {
        if (!p.cameraOn) setVideoLive(false);
      });
    },
  });

  useEffect(() => {
    return () => {
      audioPlayerRef.current?.dispose();
      videoPlayerRef.current?.dispose();
    };
  }, []);

  // 参加コード（開始前の大画面にQRを出して、生徒がその場で参加できるように）
  useEffect(() => {
    if (!lessonId) return;
    let disposed = false;
    void api<LessonSummary>(`/api/lessons/${lessonId}`)
      .then((detail) => {
        if (!disposed) setJoinCode(detail.joinCode);
      })
      .catch(() => {
        /* 参加コードが取れなくてもスライドの投影は続ける */
      });
    return () => {
      disposed = true;
    };
  }, [lessonId]);

  useEffect(() => {
    if (!joinCode) return;
    let disposed = false;
    void QRCode.toDataURL(`${window.location.origin}/join?code=${joinCode}`, {
      width: 720,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    })
      .then((url) => {
        if (!disposed) setQrDataUrl(url);
      })
      .catch(() => {
        if (!disposed) setQrDataUrl('');
      });
    return () => {
      disposed = true;
    };
  }, [joinCode]);

  // ---- 音声の出し分け ----
  // カメラ映像には音声も入っているので、映像が来ているときはそちらを鳴らし、
  // 音声のみのストリームはミュートする（同じ声が二重に鳴らないように）。
  // 受信自体は両方続けるので、切り替えで音が途切れることはない。
  // ただし先生のマイクが使えず映像だけの配信になっている場合は、
  // 音声のみのストリームを鳴らし続ける（教室が無音になるのを防ぐ）。
  const avAudioActive = videoLive && cameraOn && avHasAudio;
  useEffect(() => {
    const audioEl = audioElRef.current;
    const videoEl = videoElRef.current;
    if (audioEl) {
      audioEl.muted = !soundOn || avAudioActive;
      audioEl.volume = volume;
    }
    if (videoEl) {
      videoEl.muted = !soundOn || !avAudioActive;
      videoEl.volume = volume;
    }
  }, [soundOn, avAudioActive, volume]);

  const enableSound = useCallback(() => {
    // 自動再生の制限があるため、必ず操作を起点に再生を開始する
    audioPlayerRef.current?.enable();
    videoPlayerRef.current?.enable();
    setSoundOn(true);
  }, []);

  // ---- 画面のスリープ防止 ----
  // 投影中に教室PCの画面が暗くなると授業が止まるため、可能な環境では抑止する
  useEffect(() => {
    type WakeLockLike = { release: () => Promise<void> };
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> };
    };
    const wakeLock = nav.wakeLock;
    if (!wakeLock) return;
    let lock: WakeLockLike | null = null;
    let disposed = false;
    const acquire = async () => {
      try {
        const next = await wakeLock.request('screen');
        if (disposed) void next.release().catch(() => {});
        else lock = next;
      } catch {
        /* 権限やブラウザの制限で取れないことがある。取れなくても投影は続く */
      }
    };
    void acquire();
    // タブが裏に回るとロックは自動的に解除されるので、戻ったら取り直す
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);

  // ---- 全画面 ----
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  // 操作バーはマウスを動かしたときだけ出す（投影面に出したままにしない）
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    showControls();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [showControls]);

  // 授業前は参加用QRを出し、授業が始まってからスライドを映す
  const inLesson = status === 'live' && !!currentSlide;
  const showVideo = inLesson && cameraOn && videoLive && screenLayout !== 'slide-only';
  const videoMain = showVideo && screenLayout === 'video';
  const slideEl = currentSlide ? (
    <SlideCanvas
      pdf={pdf}
      slide={currentSlide}
      strokes={currentSlideId ? (strokes[currentSlideId] ?? []) : []}
      progressStrokes={currentProgress}
      pointer={pointer && pointer.slideId === currentSlideId ? pointer : null}
    />
  ) : null;

  return (
    <div className="screen-page" onMouseMove={showControls} onClick={showControls}>
      <div className="screen-stage">
        {inLesson && !videoMain && <div className="screen-main">{slideEl}</div>}
        {/*
          video要素は常に置いておく。作り直すとMediaSourceが張り直しになり
          映像と音が途切れるため、隠すときもDOMからは外さない
        */}
        <div className={showVideo ? (videoMain ? 'screen-main' : 'screen-sub') : 'screen-hidden'}>
          <video ref={videoElRef} className="screen-video" playsInline autoPlay />
        </div>
        {inLesson && videoMain && <div className="screen-sub">{slideEl}</div>}

        {!inLesson && (
          <div className="screen-waiting">
            <h1>{title || '授業'}</h1>
            {status === 'ended' ? (
              <p>授業は終了しました</p>
            ) : (
              <>
                <p>授業の開始を待っています</p>
                {qrDataUrl && (
                  <div className="screen-join">
                    <img className="screen-qr" src={qrDataUrl} alt="参加用QRコード" />
                    <div className="screen-join-text">
                      <p>スマートフォンで読み取って参加</p>
                      <p className="screen-join-code">{joinCode}</p>
                      <p className="screen-join-url">{window.location.origin}/join</p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {unsupportedAudio && (
        <div className="screen-audio-error" role="alert">
          <strong>この端末では音声を再生できません</strong>
          <span>
            ブラウザが {unsupportedAudio} に対応していません。
            別の端末（Windows／Chromebook／Android）でこの画面を開いてください。
          </span>
        </div>
      )}

      <div className={`screen-controls ${controlsVisible ? '' : 'screen-controls-hidden'}`}>
        {!soundOn ? (
          <button className="btn primary" onClick={enableSound}>
            ♪ 教室のスピーカーで音を鳴らす
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => setSoundOn(false)}>
              🔇 音を止める
            </button>
            <label className="screen-volume">
              音量
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => setVolume(Number(e.target.value) / 100)}
              />
            </label>
          </>
        )}
        <button className="btn" onClick={toggleFullscreen}>
          {isFullscreen ? '全画面をやめる' : '⛶ 全画面'}
        </button>
        {!connected && <span className="chip chip-offline">再接続中...</span>}
      </div>

      {/* 音声のみのストリーム用（非表示） */}
      <audio ref={audioElRef} style={{ display: 'none' }} />
    </div>
  );
}
