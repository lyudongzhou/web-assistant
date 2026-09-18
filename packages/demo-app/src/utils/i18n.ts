// 极简 i18n（演示 services.t 注入）。
//
// 原项目里的 `$tt('中文')` 宏在运行时就是宿主传入的 `services.t`（见 PROJECT.md 6.6）；
// 这里用一个「键 → 文案」的小表演示同一个通道：
//   宿主注入 services.t → 页面 ctx.t('settings.save') → 切换语言时所有页面一起变。
import type { Locale } from '../api/types'

const dictionaries: Record<Locale, Record<string, string>> = {
  'zh-CN': {
    'settings.title': '站点设置',
    'settings.description': '站点名称与界面语言由宿主注入的服务渲染',
    'settings.siteName': '站点名称',
    'settings.locale': '界面语言',
    'settings.notify': '开启通知',
    'settings.version': '后端版本',
    'settings.save': '保存',
    'settings.saved': '已保存',
    'settings.hint': '下面两行文案来自 services.t（宿主注入），切换语言即时生效',
  },
  'en-US': {
    'settings.title': 'Site settings',
    'settings.description': 'Site name & locale are rendered through host-injected services',
    'settings.siteName': 'Site name',
    'settings.locale': 'Locale',
    'settings.notify': 'Notifications',
    'settings.version': 'Backend version',
    'settings.save': 'Save',
    'settings.saved': 'Saved',
    'settings.hint': 'The two lines below come from services.t (host-injected) and follow the locale',
  },
}

/** 取文案：缺键时原样返回 key（与 runtime 的缺省 t 行为一致，方便定位漏词） */
export function translate(locale: Locale, key: string): string {
  return dictionaries[locale]?.[key] ?? dictionaries['zh-CN'][key] ?? key
}
