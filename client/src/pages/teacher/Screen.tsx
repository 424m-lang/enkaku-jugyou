import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PointerPayload } from '@shared';
import { useLessonLive } from '../../lib/useLessonLive';
import SlideCanvas from '../../components/SlideCanvas';

/**
 * 現地スクリーン投影用の表示専用ウィンドウ。
 * 生徒画面に表示しているものと同じスライド（書き込み・ポインター込み）をそのまま表示する。
 * 先生画面の「スクリーン表示」ボタンから別ウィンドウで開き、
 * プロジェクタ側のディスプレイへドラッグして全画面にする使い方を想定。
 */
export default function Screen() {
  const { id: lessonId } = useParams<{ id: string }>();
  const [pointer, setPointer] = useState<PointerPayload | null>(null);

  const { title, status, currentSlideId, currentSlide, strokes, currentProgress, pdf } =
    useLessonLive(lessonId, {
      setup: (socket) => {
        socket.on('pointer', (p) => setPointer(p));
        socket.on('slide_change', () => setPointer(null));
      },
    });

  return (
    <div className="screen-page">
      {currentSlide && status !== 'ended' ? (
        <SlideCanvas
          pdf={pdf}
          slide={currentSlide}
          strokes={currentSlideId ? (strokes[currentSlideId] ?? []) : []}
          progressStrokes={currentProgress}
          pointer={pointer && pointer.slideId === currentSlideId ? pointer : null}
        />
      ) : (
        <div className="screen-waiting">
          <h1>{title || '授業'}</h1>
          <p>{status === 'ended' ? '授業は終了しました' : 'スライドの表示を待っています...'}</p>
        </div>
      )}
    </div>
  );
}
