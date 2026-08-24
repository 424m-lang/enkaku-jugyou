import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioMode, LessonStatus, ParticipantInfo, ScreenLayout } from '@shared';
import { SCREEN_LAYOUT_LABELS } from '@shared';
import { api } from '../lib/api';
import {
  listCameras,
  startCameraBroadcast,
  supportedVideoMime,
  type CameraBroadcast,
  type CameraOption,
} from '../lib/camera';
import type { AppSocket } from '../lib/socket';
import ScreenQrModal from './ScreenQrModal';

type Props = {
  lessonId: string;
  socketRef: React.MutableRefObject<AppSocket | null>;
  status: LessonStatus;
  screenCount: number;
  participants: ParticipantInfo[];
  audioDefault: AudioMode;
  cameraOn: boolean;
  screenLayout: ScreenLayout;
  videoToStudents: boolean;
};

const LAYOUTS: ScreenLayout[] = ['slide', 'video', 'slide-only'];

/**
 * 教室の大画面まわりの操作。
 *
 * - 大画面を開くURL（別端末で開く）と、いま何台つながっているか
 * - 先生のカメラ映像（顔・手元の実演）の配信と、大画面のレイアウト
 * - 生徒端末の音声（教室で受ける生徒はミュート、遠隔の生徒だけ鳴らす）
 */
export default function ClassroomPanel({
  lessonId,
  socketRef,
  status,
  screenCount,
  participants,
  audioDefault,
  cameraOn,
  screenLayout,
  videoToStudents,
}: Props) {
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [screenUrl, setScreenUrl] = useState('');
  const [showScreenQr, setShowScreenQr] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);

  const broadcastRef = useRef<CameraBroadcast | null>(null);
  const selfViewRef = useRef<HTMLVideoElement>(null);
  const videoSupported = supportedVideoMime() !== null;

  // 画面を離れるときは必ずカメラを解放する（ランプが点いたままにならないように）
  useEffect(() => {
    return () => {
      broadcastRef.current?.stop();
      broadcastRef.current = null;
    };
  }, []);

  const refreshCameras = useCallback(() => {
    void listCameras()
      .then(setCameras)
      .catch(() => setCameras([]));
  }, []);

  useEffect(refreshCameras, [refreshCameras]);

  const startCamera = useCallback(async () => {
    if (broadcastRef.current) return;
    const socket = socketRef.current;
    if (!socket) return;
    setCameraError('');
    try {
      // 先にサーバへ知らせておく（チャンクが届いたときに中継先が決まっている状態にする）
      socket.emit('camera_state', { on: true });
      const bc = await startCameraBroadcast(socket, cameraId || undefined);
      broadcastRef.current = bc;
      // マイクが取れず映像だけになった場合は、受け手が音声のみの配信を鳴らし続ける
      socket.emit('camera_state', { on: true, hasAudio: bc.hasAudio });
      if (selfViewRef.current) selfViewRef.current.srcObject = bc.stream;
      refreshCameras(); // 許可後はカメラ名が取れるようになる
    } catch (err) {
      socket.emit('camera_state', { on: false });
      setCameraError(err instanceof Error ? err.message : 'カメラを開始できませんでした');
    }
  }, [socketRef, cameraId, refreshCameras]);

  const stopCamera = useCallback(() => {
    broadcastRef.current?.stop();
    broadcastRef.current = null;
    if (selfViewRef.current) selfViewRef.current.srcObject = null;
    socketRef.current?.emit('camera_state', { on: false });
  }, [socketRef]);

  // カメラを切り替えるときは、いったん止めてから選び直した機器で開き直す
  const changeCamera = useCallback(
    async (deviceId: string) => {
      setCameraId(deviceId);
      if (!broadcastRef.current) return;
      stopCamera();
      const socket = socketRef.current;
      if (!socket) return;
      setCameraError('');
      try {
        socket.emit('camera_state', { on: true });
        const bc = await startCameraBroadcast(socket, deviceId || undefined);
        broadcastRef.current = bc;
        socket.emit('camera_state', { on: true, hasAudio: bc.hasAudio });
        if (selfViewRef.current) selfViewRef.current.srcObject = bc.stream;
      } catch (err) {
        socket.emit('camera_state', { on: false });
        setCameraError(err instanceof Error ? err.message : 'カメラを切り替えられませんでした');
      }
    },
    [socketRef, stopCamera]
  );

  const openScreen = useCallback(async () => {
    try {
      const { screenToken } = await api<{ screenToken: string }>(
        `/api/lessons/${lessonId}/screen-token`
      );
      setScreenUrl(`${window.location.origin}/screen/${lessonId}?k=${screenToken}`);
      setShowScreenQr(true);
    } catch {
      // トークンが取れなくても、先生自身の端末なら拡張ディスプレイで使える
      setScreenUrl(`${window.location.origin}/screen/${lessonId}`);
      setShowScreenQr(true);
    }
  }, [lessonId]);

  const setAudioDefault = useCallback(
    (mode: AudioMode) => {
      socketRef.current?.emit('set_audio_default', { mode }, () => {});
    },
    [socketRef]
  );

  const setParticipantAudio = useCallback(
    (participantId: string, mode: AudioMode | null) => {
      socketRef.current?.emit('set_participant_audio', { participantId, mode }, () => {});
    },
    [socketRef]
  );

  const setLayout = useCallback(
    (layout: ScreenLayout) => socketRef.current?.emit('set_av_config', { layout }),
    [socketRef]
  );

  const remoteCount = participants.filter((p) => p.audio === 'on').length;
  const roomCount = participants.length - remoteCount;

  return (
    <div className="card classroom-card">
      <div className="classroom-head">
        <h3>教室の大画面</h3>
        <span className={screenCount > 0 ? 'chip chip-live' : 'chip chip-offline'}>
          {screenCount > 0 ? `接続中 ${screenCount}台` : '未接続'}
        </span>
      </div>

      <div className="classroom-row">
        <button className="btn" onClick={() => void openScreen()}>
          大画面のURL・QR
        </button>
      </div>

      {/* ---- カメラ ---- */}
      <div className="classroom-sec">
        <span className="classroom-label">先生のカメラ</span>
        {!videoSupported ? (
          <p className="muted small">この端末（ブラウザ）は映像の配信に対応していません</p>
        ) : (
          <>
            <div className="classroom-row">
              {cameraOn ? (
                <button className="btn danger" onClick={stopCamera}>
                  カメラを止める
                </button>
              ) : (
                <button className="btn primary" onClick={() => void startCamera()}>
                  カメラを映す
                </button>
              )}
              {cameras.length > 1 && (
                <select
                  className="classroom-select"
                  value={cameraId}
                  onChange={(e) => void changeCamera(e.target.value)}
                  title="顔を映すカメラと、手元を映すカメラを切り替えます"
                >
                  <option value="">既定のカメラ</option>
                  {cameras.map((c) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {cameraError && <p className="error small">{cameraError}</p>}
            <video
              ref={selfViewRef}
              className={cameraOn ? 'classroom-selfview' : 'screen-hidden'}
              muted
              playsInline
              autoPlay
            />
          </>
        )}
      </div>

      {/* ---- 大画面のレイアウト ---- */}
      {cameraOn && (
        <div className="classroom-sec">
          <span className="classroom-label">大画面の見せ方</span>
          <div className="classroom-row">
            {LAYOUTS.map((l) => (
              <button
                key={l}
                className={`btn tool ${screenLayout === l ? 'tool-active' : ''}`}
                onClick={() => setLayout(l)}
              >
                {SCREEN_LAYOUT_LABELS[l]}
              </button>
            ))}
          </div>
          <label className="classroom-check">
            <input
              type="checkbox"
              checked={videoToStudents}
              onChange={(e) =>
                socketRef.current?.emit('set_av_config', { videoToStudents: e.target.checked })
              }
            />
            遠隔の生徒にも映像を送る
          </label>
          <p className="muted small">
            映像は通信量が大きいので、ふだんは送りません。手元の作業を見せるときだけ入れてください。
          </p>
        </div>
      )}

      {/* ---- 生徒端末の音声 ---- */}
      <div className="classroom-sec">
        <span className="classroom-label">生徒の端末の音声</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${audioDefault === 'off' ? 'tool-active' : ''}`}
            onClick={() => setAudioDefault('off')}
            title="教室で受ける授業。音は大画面のスピーカーからだけ出します"
          >
            🔇 全員ミュート
          </button>
          <button
            className={`btn tool ${audioDefault === 'on' ? 'tool-active' : ''}`}
            onClick={() => setAudioDefault('on')}
            title="全員が遠隔で受ける授業"
          >
            🔊 全員 音声あり
          </button>
        </div>
        <p className="muted small">
          教室 {roomCount}人 / 遠隔 {remoteCount}人
          {status === 'live' && screenCount === 0 && audioDefault === 'off' && (
            <span className="warn"> ・大画面が未接続です</span>
          )}
        </p>
        <button className="btn link-btn" onClick={() => setShowParticipants((v) => !v)}>
          {showParticipants ? '個別の設定を閉じる' : `個別に変える（${participants.length}人）`}
        </button>
        {showParticipants && (
          <ul className="participant-list">
            {participants.length === 0 && <li className="muted small">まだ誰も参加していません</li>}
            {participants.map((p) => (
              <li key={p.id} className="participant-row">
                <span className={p.online ? 'participant-name' : 'participant-name offline'}>
                  {p.displayName}
                  {!p.online && <span className="muted small"> (切断中)</span>}
                </span>
                <button
                  className={`btn small ${p.audio === 'on' ? 'tool-active' : ''}`}
                  onClick={() => setParticipantAudio(p.id, p.audio === 'on' ? 'off' : 'on')}
                  title={p.audio === 'on' ? 'この生徒の端末で音が鳴ります' : 'ミュート中'}
                >
                  {p.audio === 'on' ? '🔊 遠隔' : '🔇 教室'}
                </button>
                {p.overridden && (
                  <button
                    className="btn small link-btn"
                    onClick={() => setParticipantAudio(p.id, null)}
                    title="授業の既定に戻す"
                  >
                    既定へ
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {showScreenQr && screenUrl && (
        <ScreenQrModal screenUrl={screenUrl} onClose={() => setShowScreenQr(false)} />
      )}
    </div>
  );
}
