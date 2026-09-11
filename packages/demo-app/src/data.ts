// 共享 mock 数据（模拟老项目的用户数据源，列表页与详情页共用）
export interface User {
  id: number
  name: string
  email: string
  role: string
}

export const mockUsers: User[] = [
  { id: 1, name: '张三', email: 'zhangsan@example.com', role: '管理员' },
  { id: 2, name: '李四', email: 'lisi@example.com', role: '普通用户' },
  { id: 3, name: '王五', email: 'wangwu@example.com', role: '普通用户' },
  { id: 4, name: '赵六', email: 'zhaoliu@example.com', role: '访客' },
  { id: 5, name: '钱七', email: 'qianqi@example.com', role: '管理员' },
  { id: 6, name: '孙八', email: 'sunba@example.com', role: '访客' },
  { id: 7, name: '周九', email: 'zhoujiu@example.com', role: '普通用户' },
]

export function findUser(id: unknown): User | undefined {
  return mockUsers.find((user) => String(user.id) === String(id))
}

export interface StatItem {
  label: string
  value: string
}

export const mockStats: StatItem[] = [
  { label: '用户总数', value: '1,284' },
  { label: '今日活跃', value: '326' },
  { label: '订单数', value: '89' },
  { label: '转化率', value: '6.9%' },
]

export interface Order {
  id: string
  user: string
  amount: number
  status: string
}

export const mockOrders: Order[] = [
  { id: 'SO-1001', user: '张三', amount: 299, status: '已支付' },
  { id: 'SO-1002', user: '李四', amount: 128, status: '待支付' },
  { id: 'SO-1003', user: '王五', amount: 899, status: '已发货' },
  { id: 'SO-1004', user: '赵六', amount: 59, status: '已取消' },
]
