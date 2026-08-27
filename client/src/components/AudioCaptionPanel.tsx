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
  /** いま字幕を使っている生徒の人数 */
  captionUsers: number;
};

export default function AudioCaptionPanel({
  socketRef,
  status,
  screenCount,
  participants,
  audioDefault,
  captionsOnScreen,
  captionsForStudents,
  captionUsers,
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

  const setCaptionsOnScreen = useCallback(
    (onScreen: boolean) => {
      socketRef.current?.emit('set_captions', { onScreen }, () => {});
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
            <span className="warn">
              {' '}
              ・教室モニターが未接続です（同じ教室で先生が話している場合は不要）
            </span>
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
      {/* 「字幕を作る」というスイッチは置かない。出し先がひとつでもONなら作り始める。
          生徒の端末側は先生が決めない。誰に字幕が要るかは本人にしか分からず、
          先生が押し忘れれば必要な生徒が読めなくなるため */}
      <div className="classroom-sec">
        <span className="classroom-label">自動字幕</span>
        <div className="classroom-row">
          <button
            className={`btn tool ${captionsOnScreen ? 'tool-active' : ''}`}
            onClick={() => setCaptionsOnScreen(!captionsOnScreen)}
            disabled={screenCount === 0 && !captionsOnScreen}
            title={
              screenCount === 0
                ? '教室モニターが接続されていません'
                : '教室モニターの下に字幕の帯を出します'
            }
          >
            🖥 教室モニター
          </button>
          {/* 人数そのもので色を決める。captionsForStudents を使うと、
              人数が届く前の一瞬「0人が使用中」が強調されて出ることがある */}
          <span className={captionUsers > 0 ? 'caption-users on' : 'caption-users'}>
            📱 生徒の端末{' '}
            {captionUsers > 0 ? `${captionUsers}人が使用中` : '誰も使っていません'}
          </span>
        </div>
        <p className="muted small">
          遠隔で参加している生徒は各自の端末で字幕を出せます。
          {captionsEnabled
            ? '先生の話を文字にしています。自動認識なので誤変換があります。Chrome・Edgeでのみ動きます。'
            : '教室モニターに出すか、生徒が1人でも字幕を出すと、認識が始まります。'}
        </p>
      </div>
    </>
  );
}
