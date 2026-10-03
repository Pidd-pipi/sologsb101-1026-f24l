/**
 * 路由表：/parcels、/tanks、/reservations、/batches、/operations、/mlf、/tasting
 * 页面按路由懒加载，构建时自动分包。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

export const ROUTES = {
  parcels: '/parcels',
  tanks: '/tanks',
  reservations: '/reservations',
  batches: '/batches',
  operations: '/operations',
  mlf: '/mlf',
  tasting: '/tasting'
} as const

export interface NavItem {
  path: string
  label: string
  icon: string
  hint: string
}

/** 侧边导航配置（与路由一一对应） */
export const NAV_ITEMS: NavItem[] = [
  { path: ROUTES.parcels, label: '地块与品种', icon: '🍇', hint: '地块台账与在罐批次' },
  { path: ROUTES.tanks, label: '发酵罐配置', icon: '🛢️', hint: '罐位状态与占用校验' },
  { path: ROUTES.reservations, label: '到厂预约', icon: '📞', hint: '电话抢罐与容量承诺' },
  { path: ROUTES.batches, label: '入罐与读数', icon: '📈', hint: '到厂入罐与发酵读数' },
  { path: ROUTES.operations, label: '作业编排', icon: '🔁', hint: '倒罐 / 压帽 / 淋皮' },
  { path: ROUTES.mlf, label: '苹乳发酵', icon: '🧪', hint: '苹果酸下降跟踪' },
  { path: ROUTES.tasting, label: '品评与档案', icon: '🍷', hint: '品评调配与导出' }
]

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: ROUTES.parcels },
  {
    path: ROUTES.parcels,
    name: 'parcels',
    component: () => import('@/pages/ParcelList.vue'),
    meta: { title: '地块与品种台账' }
  },
  {
    path: ROUTES.tanks,
    name: 'tanks',
    component: () => import('@/pages/TankBoard.vue'),
    meta: { title: '发酵罐容量配置与罐位看板' }
  },
  {
    path: ROUTES.reservations,
    name: 'reservations',
    component: () => import('@/pages/ReservationBoard.vue'),
    meta: { title: '到厂预约与容量承诺' }
  },
  {
    path: ROUTES.batches,
    name: 'batches',
    component: () => import('@/pages/BatchReading.vue'),
    meta: { title: '入罐登记与发酵读数' }
  },
  {
    path: ROUTES.operations,
    name: 'operations',
    component: () => import('@/pages/OperationPlan.vue'),
    meta: { title: '倒罐与压帽作业编排' }
  },
  {
    path: ROUTES.mlf,
    name: 'mlf',
    component: () => import('@/pages/MlfBoard.vue'),
    meta: { title: '苹果酸乳酸发酵跟踪' }
  },
  {
    path: ROUTES.tasting,
    name: 'tasting',
    component: () => import('@/pages/TastingExport.vue'),
    meta: { title: '品评调配与批次档案' }
  },
  { path: '/:pathMatch(.*)*', redirect: ROUTES.parcels }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export default router
