import type { ReactionButtonDef } from '@shared';

const COMMENT_LABEL = 'コメント';
const COMMENT_COLOR = '#6b7280';

/** リアクション種別(kind)をボタン設定に基づいてラベル・色へ変換するヘルパー */
export function makeReactionMeta(buttons: ReactionButtonDef[]) {
  return {
    label(kind: string): string {
      if (kind === 'comment') return COMMENT_LABEL;
      return buttons.find((b) => b.key === kind)?.label ?? kind;
    },
    color(kind: string): string {
      if (kind === 'comment') return COMMENT_COLOR;
      return buttons.find((b) => b.key === kind)?.color ?? COMMENT_COLOR;
    },
  };
}
