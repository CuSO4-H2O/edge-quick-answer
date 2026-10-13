/**
 * 面板的建立与 hooks 统一入口（避免多处 mountPanel 调用各写一份回调）。
 *
 * 注意：这里刻意**不** import impl.ts —— 那会形成循环依赖
 * （impl → panelHost → impl）。需要的信息（如"脚本是否已过期"）
 * 由调用方通过 base 参数传进来。
 */

import { mountPanel, type MountedPanel, type PanelHooks } from './mountPanel';
import { readPref, writePref } from '../shared/history';
import { SETTINGS_DEFAULTS } from '../shared/constants';
import { clearOptionHighlight } from './highlight';

const HL_PREF = 'highlightAnswer';

/** 当前是否启用"标注答案选项"（会话级记忆，关闭浮层后仍生效） */
let highlightEnabled = readPref(HL_PREF, SETTINGS_DEFAULTS.highlightAnswer);

export function setHighlightEnabled(v: boolean): void {
  highlightEnabled = v;
  writePref(HL_PREF, v);
  if (!v) clearOptionHighlight();
}

export interface PanelBaseHooks {
  onCaptureRegion: PanelHooks['onCaptureRegion'];
  onUserMoved: PanelHooks['onUserMoved'];
  scriptStale: boolean;
  onDiagnose: PanelHooks['onDiagnose'];
  onSnapshot: PanelHooks['onSnapshot'];
}

export function createPanel(
  host: HTMLElement,
  onClose: () => void,
  base: PanelBaseHooks,
): MountedPanel {
  return mountPanel(host, onClose, {
    ...base,
    highlightEnabled,
    onHighlightPrefChange: setHighlightEnabled,
  });
}
