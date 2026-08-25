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
  captionsOnScreen: boolean;
  captionsForStudents: boolean;
};

export default function AudioCaptionPanel({
  socketRef,
  status,
  screenCount,
  participants,
  audioDefault,
  captionsOnScreen,
  captionsForStudents,
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
    (p: { onScreen?: boolean; forStudents?: boolean }) => {
      socketRef.current?.emit('set_captions', p, () => {});
    },
    [socketRef]
  );

  const remoteCount = participants.filter((p) => p.audio === 'on').length;
  const roomCount = participants.length - remoteCount;
  // 出し先がひとつでもONなら字幕を作っている（サーバ側と同じ導出）
  const captionsEnabled = captionsOnScreen || captionsForStudents;

  return (
    <>
      {/* ---- 生徒端末の音声 ---- */}
      {/* 音声と字幕は決める内容が別なので、教室モニター設定と同じように線で区切る */}
      <div className="classroom-sec classroom-sec-divided">
        <span className="classroom-label">生徒の端末の音声</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${audioDefault === 'off' ? 'tool-active' : ''}`}
            onClick={() => setAudioDefault('off')}
            title="教室で受ける授業。音は教室モニターのスピーカーからだけ出します"
          >
            🔇 全員 教室から参加
            <span className="btn-sub">全端末ミュート</span>
          </button>
          <button
            className={`btn tool ${audioDefault === 'on' ? 'tool-active' : ''}`}
            onClick={() => setAudioDefault('on')}
            title="全員が遠隔で受ける授業。各自の端末から音が出ます"
          >
            🔊 全員 遠隔で参加
            <span className="btn-sub">全端末 音声ON</span>
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
      {/* 「字幕を作る」というスイッチは置かない。出し先をONにすれば作り始め、
          両方OFFにすればやめる。作っているのに誰にも出ていない状態を作らせない */}
      <div className="classroom-sec">
        <span className="classroom-label">自動字幕を出す先</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${captionsOnScreen ? 'tool-active' : ''}`}
            onClick={() => setCaptions({ onScreen: !captionsOnScreen })}
            disabled={screenCount === 0 && !captionsOnScreen}
            title={
              screenCount === 0
                ? '教室モニターが接続されていません'
                : '教室モニターの下に字幕の帯を出します'
            }
          >
            🖥 教室モニター
          </button>
          <button
            className={`btn tool ${captionsForStudents ? 'tool-active' : ''}`}
            onClick={() => setCaptions({ forStudents: !captionsForStudents })}
            title="生徒の端末に字幕を出せるようにします。出すかどうかは生徒が各自で決めます"
          >
            📱 生徒の端末
          </button>
        </div>
        <p className="muted small">
          {captionsEnabled ? (
            <>
              先生の話を文字にしています。自動認識なので誤変換があります。
              Chrome・Edgeでのみ動きます。
              {captionsForStudents && ' 生徒は自分の画面で字幕を消せます。'}
            </>
          ) : screenCount === 0 ? (
            '押した先に字幕が出ます。教室モニターは接続されると選べます。'
          ) : (
            '押した先に字幕が出ます。どちらも押さなければ字幕は作りません。'
          )}
        </p>
      </div>
    </>
  );
}
