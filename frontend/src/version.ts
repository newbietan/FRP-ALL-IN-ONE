/**
 * 系统版本号 — 唯一定义处
 *
 * 构建时可通过环境变量覆盖：
 *   VITE_APP_VERSION=2.5.1 npm run build
 *
 * 本地开发默认使用 'dev'，生产构建使用 package.json 中的版本号或环境变量
 */
export const APP_VERSION: string =
  (import.meta as any).env?.VITE_APP_VERSION ||
  (import.meta as any).env?.VITE_APP_VERSION_NAME ||
  'v3.0.0';

/** 格式化显示版本（如 "V2.4.0-Stable"） */
export const APP_VERSION_DISPLAY = `V${APP_VERSION.replace(/^v/i, '')}`;

/** GitHub 仓库（用于检查更新） */
export const GITHUB_REPO = 'newbietan/FRP-ALL-IN-ONE';

/** 纯版本号（用于与 GitHub release tag 比较，如 "2.4.0"） */
export const VERSION_NUMBER = APP_VERSION.replace(/^v/i, '').replace(/-.*$/, '');
