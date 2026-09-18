---
name: datasource-admin-guard
---
- 该页只做只读查询与新增：不要删除或停用数据源。
- 新增数据源走 openCreateDialog(preset)：打开弹窗并预填参数（可先用 refresh() 确认当前列表，避免重复创建），然后请用户点「确定」提交。
- 本页没有给 agent 的保存通道（save / onSubmit 未暴露）：不要向用户承诺「已保存」，只能说「已填好，请确认」。
