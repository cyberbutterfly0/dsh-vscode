/**
 * 文案表。中文为主，键名英文。
 *
 * 用法：`t('chat.newSession')`；需要插值用 `t('session.switched', { id })`。
 * 加语言就再建一张同样键的表，扩 `Dict`；这里不引任何第三方 i18n 库。
 */

const zh = {
  'ext.connecting': '正在连接 dsh…',
  'ext.connected': '已连接 dsh（{authority}）',
  'ext.connectFailed': '连接 dsh 失败：{message}',
  'ext.disconnected': '已断开 dsh',
  'ext.noDsh': '没找到 dsh。请先安装：npm i -g @deepseek-ai/dsh',
  'ext.noDsh.install': '去安装',
  'ext.needToken': '需要 dsh 的启动 URL（含 token）',
  'ext.tokenPrompt': '粘贴 dsh 启动输出里的那行 URL',
  'ext.tokenEmpty': 'URL 里没有 token',
  'ext.runtimeRestarted': 'dsh runtime 已重启',
  'ext.spawnFailed': '启动 dsh 失败：{message}',

  'cmd.openChat': '打开 dsh 聊天',
  'cmd.newSession': '新建 dsh 会话',
  'cmd.connectExisting': '连接已有的 dsh 实例',
  'cmd.restartRuntime': '重启 dsh runtime',
  'cmd.disconnect': '断开 dsh 连接',
  'cmd.openFullUI': '打开完整 dsh 界面',
  'cmd.selectModel': '选择模型',
  'cmd.selectPermission': '选择权限档',
  'cmd.pickWorkspace': '选择工作目录',
  'cmd.showLog': '显示 dsh 日志',
  'cmd.revealState': '打开凭据文件',
  'cmd.refreshSessions': '刷新会话列表',

  'chat.title': 'dsh',
  'chat.newSessionTitle': '新会话',
  'chat.placeholder': '输入消息，Enter 发送，Shift+Enter 换行',
  'chat.send': '发送',
  'chat.stop': '停止',
  'chat.attach': '附加文件',
  'chat.newChat': '新会话',
  'chat.history': '历史会话',
  'chat.openFull': '完整界面',
  'chat.models': '模型',
  'chat.permission': '权限',
  'chat.answer': '提交',
  'chat.dismiss': '忽略',
  'chat.approve': '允许',
  'chat.deny': '拒绝',
  'chat.approveAlways': '本次会话始终允许',
  'chat.loadOlder': '加载更早的消息',

  'status.connecting': '连接中',
  'status.connected': '已连接',
  'status.reconnecting': '重连中',
  'status.disconnected': '未连接',
  'status.running': '运行中',
  'status.thinking': '思考中',

  'session.switched': '已切换到会话 {id}',
  'session.created': '已新建会话',
  'session.empty': '还没有会话',
  'session.untitled': '未命名会话',

  'perm.readOnly': '只读',
  'perm.workspaceWrite': '工作区可写',
  'perm.fullAccess': '完全访问',

  'log.show': '显示日志',

  'notice.noWorkspace': '当前没有打开工作区，dsh 会把会话建在用户目录',
  'notice.needConfig': '请在设置里配置 dsh.mode / dsh.attachUrl',
  'notice.authExpired': 'dsh 凭据已失效，请重新提供启动 URL',
};

export type Dict = typeof zh;
export type StringKey = keyof Dict;

let table: Dict = zh;

export function setLocale(locale: string): void {
  // 目前只有中文；其他语言回退到中文，等有了第二张表再切
  table = zh;
  void locale;
}

export function t(key: StringKey, params?: Record<string, string | number>): string {
  const raw = (table[key] ?? key) as string;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}
