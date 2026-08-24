import { useCallback, useState } from 'react';
import type { AudioMode, LessonStatus, ParticipantInfo } from '@shared';
import type { AppSocket } from '../lib/socket';

/**
 * 「誰にどう音と字幕を届けるか」の設定。
 *
 * 音声と字幕を同じ窓にまとめてあるのは、どちらも「教室で受ける生徒」と
 * 「遠隔で受ける生徒」で答えが変わる設定で、片方だけ決めても意味をなさないため。
 */

type Props = {
  socketRef: React.MutableRefObject<AppSocket | null>;
  status: LessonStatus;
  screenCount: number;
  participants: ParticipantInfo[];
  audioDefault: AudioMode;
  captionsEnabled: boolean;
  captionsOnScreen: boolean;
};

export default function AudioCaptionPanel({
  socketRef,
  status,
  screenCount,
  participants,
  audioDefault,
  captionsEnabled,
  captionsOnScreen,
}: Props) {
  const [showParticipants, setShowParticipants] = useState(false);

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

  const setCaptions = useCallback(
    (p: { enabled?: boolean; onScreen?: boolean }) => {
      socketRef.current?.emit('set_captions', p, () => {});
    },
    [socketRef]
  );

  const remoteCount = participants.filter((p) => p.audio === 'on').length;
  const roomCount = participants.length - remoteCount;

  return (
    <>
      {/* ---- 生徒端末の音声 ---- */}
      <div className="classroom-sec">
        <span className="classroom-label">生徒の端末の音声</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${audioDefault === 'off' ? 'tool-active' : ''}`}
            onClick={() => setAudioDefault('off')}
            title="教室で受ける授業。音は教室モニターのスピーカーからだけ出します"
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
            <span className="warn"> ・教室モニターが未接続です</span>
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

      {/* ---- 自動字幕 ---- */}
      <div className="classroom-sec">
        <span className="classroom-label">自動字幕</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${captionsEnabled ? 'tool-active' : ''}`}
            onClick={() => setCaptions({ enabled: !captionsEnabled })}
            title="先生の話を文字にします。遠隔の生徒は自分の画面で出し入れできます"
          >
            {captionsEnabled ? '字幕オン' : '字幕オフ'}
          </button>
        </div>
        <p className="muted small">
          自動認識なので誤変換があります。気になるときはいつでも切れます。
          {captionsEnabled && ' Chrome・Edgeでのみ動きます。'}
        </p>
      </div>

      <div className="classroom-sec">
        <span className="classroom-label">教室モニターの字幕</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${captionsOnScreen ? 'tool-active' : ''}`}
            onClick={() => setCaptions({ onScreen: !captionsOnScreen })}
            disabled={screenCount === 0}
            title={
              screenCount === 0
                ? '教室モニターが接続されていません'
                : '教室モニターの下に字幕の帯を出します'
            }
          >
            {captionsOnScreen ? 'モニターに出す' : 'モニターには出さない'}
          </button>
        </div>
        <p className="muted small">
          {screenCount === 0
            ? '教室モニターが接続されると選べます。'
            : '教室で受ける生徒はモニターの字幕を見ます。遠隔の生徒は各自の画面で出し入れします。'}
        </p>
      </div>
    </>
  );
}
