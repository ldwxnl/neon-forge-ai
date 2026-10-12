'use strict';

/* ============================================================
 * lib/goals.js —— 目标系统。
 *
 * 目标由 LLM 自己决定：可以新建、推进、完成、放弃、修改。
 * 没有目标时，由反馈层的反思提示模型主动生成一个（不是代码让它发呆）。
 *
 * 本文件只负责「目标的存储与状态迁移」，本身不做决策；
 * 决策来自 loop.js 里反馈层（L5）的 LLM 输出，交给 applyReflection 落地。
 * ============================================================ */

class Goals {
  constructor(memory) {
    this.mem = memory;
  }

  get current() { return this.mem.goal; }

  /** 给提示词用的当前目标描述 */
  describe() {
    const g = this.mem.goal;
    if (!g) return '（当前没有目标）';
    return `${g.text}（${g.term || '短期'}）` + (g.progress ? `　进度：${g.progress}` : '');
  }

  /**
   * 应用反馈层（L5）的反思结果。
   * @param {object} reflection {
   *   goalDecision: {
   *     kind: 'continue'|'progress'|'complete'|'abandon'|'new',
   *     progress?: string,
   *     newGoal?: { text: string, term?: '短期'|'长期' },
   *     reason?: string
   *   }
   * }
   * @returns {string} 人类可读的目标变化描述
   */
  applyReflection(reflection) {
    const d = (reflection && reflection.goalDecision) || null;
    if (!d || !d.kind) return '';

    switch (d.kind) {
      case 'continue':
        return '';

      case 'progress': {
        if (this.mem.goal && d.progress) {
          this.mem.updateGoal({ progress: d.progress });
          return `目标进度更新：${d.progress}`;
        }
        return '';
      }

      case 'complete': {
        const g = this.mem.goal;
        if (g) {
          this.mem.closeGoal('完成：' + (d.reason || ''));
          this.mem.addEpisodic(`完成目标「${g.text}」`);
          return `目标完成：${g.text}`;
        }
        return '';
      }

      case 'abandon': {
        const g = this.mem.goal;
        if (g) {
          this.mem.closeGoal('放弃：' + (d.reason || ''));
          this.mem.addEpisodic(`放弃目标「${g.text}」（${d.reason || ''}）`);
          return `放弃目标：${g.text}`;
        }
        return '';
      }

      case 'new': {
        const ng = d.newGoal;
        if (ng && ng.text) {
          this.mem.setGoal({
            text: String(ng.text).slice(0, 200),
            term: ng.term === '长期' ? '长期' : '短期',
            progress: '',
            createdAt: Date.now()
          });
          this.mem.addEpisodic(`定下新目标「${ng.text}」`);
          return `新目标：${ng.text}`;
        }
        return '';
      }

      default:
        return '';
    }
  }
}

module.exports = { Goals };
