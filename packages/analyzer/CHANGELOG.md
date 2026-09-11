# @webassistant/analyzer

## 0.2.0

### Minor Changes

- analyzer：展开「外部泛型包装的项目内类型」，manifest 不再只留裸名字

  - 外部 **mapped 类型**（`Partial<T>` / `Required<T>` / `Readonly<T>` / `Pick<T, K>` / `Omit<T, K>`）在类型参数含项目内类型时按对象展开：
    `setFilter(patch: Partial<DatasourceFilter>)` → `(patch: { keyword?: string; datasourceType?: string; ... })`
  - 外部**泛型实例化**（`Promise<T>` / `Set<T>` / `AxiosResponse<T>`）保留名字但继续展开类型参数：
    `Promise<DatasourceVO>` → `Promise<{ id: number; ... }>`
  - 修节点定位：类型注解偏移会收敛到「起点相同的最外层类型节点」，`Partial<X>` 不再退化成泛型声明形态 `Partial<T>`、`Foo[]` 不再丢掉 `[]`
  - 不变的行为：外部**非泛型**类型（`Record<string, string>`、`AxiosResponse`）仍只打印名字；找不到 tsconfig 时的纯语法降级、深度上限与环检测保持原样

## 0.1.2

### Patch Changes

- 发布 patch 版本，更新内部依赖联动。
- Updated dependencies
  - @webassistant/protocol@0.1.2
