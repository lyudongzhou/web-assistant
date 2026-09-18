// 订单资源：演示「agent 直传 props + 等一条匹配的观察结果」——
// 订单号是 agent 从「用户列表」的观察结果里挑出来后，用 keyword/status 继续筛的那种典型链路。
import { http } from '../utils/request'
import { reportData } from '../utils/httpClient'
import { buildQuery } from './query'
import type { MockFail, Order, OrderStatus } from './types'

/** 订单列表（GET /api/orders?status=）——dataSources 声明在清单里（原样上报 + runtime 摘要） */
export async function listOrders(params: { status?: OrderStatus | ''; fail?: MockFail } = {}): Promise<Order[]> {
  const url = `/api/orders${buildQuery({ status: params.status, fail: params.fail })}`
  const orders = await http<Order[]>(url)
  reportData('order-list', orders, { url })
  return orders
}

/** 订单详情（GET /api/orders/:id） */
export async function getOrder(id: string): Promise<Order> {
  const url = `/api/orders/${id}`
  const order = await http<Order>(url)
  reportData('order-detail', order, { url })
  return order
}
