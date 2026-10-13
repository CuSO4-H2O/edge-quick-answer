/**
 * 截图的返回类型。
 *
 * 单独放一个文件是为了避免循环依赖：
 * impl.ts → ChatPanel.tsx → impl.ts（为了这个类型）会成环。
 */

export interface CaptureOutcome {
  /** 成功时是 JPEG data URL；用户取消或失败时为 null */
  dataUrl: string | null;
  /** 失败原因，仅在 dataUrl 为 null 且出错时存在 */
  error?: string;
  /**
   * 是否是"缺少截图权限"导致的失败。
   *
   * 这种情况需要给用户**可操作**的提示：网页里的按钮点击不会授予 activeTab，
   * 所以后台调用 captureVisibleTab 会被拒。改用扩展图标菜单或快捷键即可。
   */
  permissionIssue?: boolean;
}
