---
name: datasource-admin-guard
---
- 该页只做只读查询与新增：不要删除或停用数据源。
- 调用 save() 前先用 refresh() 确认当前列表，避免重复创建。
