---
"@webassistant/protocol": minor
"@webassistant/analyzer": minor
"@webassistant/vite-plugin-wc": minor
---

**项目规则：`wc.pages.json` → `manifest.rules` → system prompt**（两级规则文档，改规则无需重启 agent-server）

- **`analyzer`**：新增 `rules.ts`（`resolveRuleEntries`）—— 把 `wc.pages.json` 的 `rules` 声明
  （文件路径 / 目录（自动收集 `.md`、按文件名排序）/ 内联 `{ name, content }`，支持 frontmatter
  `name` / `disabled`，字段对齐 Cline SDK 的 `RuleConfig`）解析成 `ManifestRule[]`；
  **analyzer 与 `vite-plugin-wc` 共用同一实现**，避免两条生成路径漂移。
- **`protocol`**：新增 `ManifestRule` 与 `manifest.rules` / `pages[].rules` 字段、`wcPages` 的 `rules` 声明类型。
- **`vite-plugin-wc`**：manifest 增量生成接入 rules —— 指纹变化即重算；未声明但旧 manifest 有 `rules` →
  保留旧值（与 `dataSources` 同款「手工字段保留」，页面级同样适用）；dev watch 把规则文件/目录纳入监听，
  改动即增量重生成。
- **agent-server**（不在 changeset）：`ManifestService.getRules()` + `buildAgentContext()` 把 manifest 级规则
  拼进 system prompt 的「项目规则」段（**优先于通用规则**）、页面级规则拼在「可用页面」列表里对应页面条目下
  （跳过 `disabled`）；本地 manifest 走 mtime 热重载、远程走定期刷新。
