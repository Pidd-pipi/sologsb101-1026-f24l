/**
 * 按批次派生比重序列、日均下降速率与发酵停滞判定
 * 被批次读数页、品评页与苹乳页消费。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ReadingPoint } from '@/types/reading'
import { STUCK_DECLINE_THRESHOLD } from '@/types/reading'
import type { ReadingRow } from '@/utils/db'
import {
  fermentationStage,
  gravityDeclinePerDay,
  isOverTemp,
  potentialAbv,
  stageTone,
  type FermentStage
} from '@/utils/gravity'

export interface FermentTrend {
  /** 按日期升序的读数趋势点 */
  points: ComputedRef<ReadingPoint[]>
  /** 平均比重日下降速率 */
  avgDeclinePerDay: ComputedRef<number>
  /** 是否疑似发酵停滞（末尾连续两次下降均低于阈值） */
  stuck: ComputedRef<boolean>
  /** 超温天数 */
  overTempDays: ComputedRef<number>
  /** 最新比重 */
  latestGravity: ComputedRef<number>
  /** 当前发酵阶段 */
  stage: ComputedRef<FermentStage>
  /** 阶段对应的标签配色 */
  tone: ComputedRef<'primary' | 'success' | 'warning' | 'info'>
  /** 潜在酒精度（由首个读数估算） */
  potential: ComputedRef<number>
  /** 自绘趋势条需要的最大最小比重 */
  range: ComputedRef<{ min: number; max: number }>
}

/** 传入某个批次的读数集合（已按日期升序），返回派生指标 */
export function useFermentTrend(readings: Ref<ReadingRow[]>): FermentTrend {
  const points = computed<ReadingPoint[]>(() =>
    readings.value.map((row, index) => {
      const prev = index > 0 ? readings.value[index - 1] : null
      const days = prev
        ? (new Date(row.date).getTime() - new Date(prev.date).getTime()) / 86400000
        : 0
      return {
        ...row,
        declinePerDay: prev ? gravityDeclinePerDay(prev.gravity, row.gravity, days) : 0,
        overTemp: isOverTemp(row.tempC)
      }
    })
  )

  const avgDeclinePerDay = computed(() => {
    const list = points.value.slice(1)
    if (list.length === 0) return 0
    return Number((list.reduce((sum, item) => sum + item.declinePerDay, 0) / list.length).toFixed(4))
  })

  const stuck = computed(() => {
    const tail = points.value.slice(-2)
    if (tail.length < 2) return false
    return tail.every((item) => item.declinePerDay > 0 && item.declinePerDay < STUCK_DECLINE_THRESHOLD)
  })

  const overTempDays = computed(() => points.value.filter((item) => item.overTemp).length)
  const latestGravity = computed(() =>
    points.value.length > 0 ? points.value[points.value.length - 1].gravity : 0
  )
  const stage = computed<FermentStage>(() =>
    latestGravity.value > 0 ? fermentationStage(latestGravity.value) : '起酵'
  )
  const potential = computed(() =>
    points.value.length > 0 ? potentialAbv(points.value[0].gravity) : 0
  )
  const range = computed(() => {
    const values = points.value.map((item) => item.gravity)
    if (values.length === 0) return { min: 0.99, max: 1.1 }
    return { min: Math.min(...values) - 0.005, max: Math.max(...values) + 0.005 }
  })

  return {
    points,
    avgDeclinePerDay,
    stuck,
    overTempDays,
    latestGravity,
    stage,
    tone: computed(() => stageTone(stage.value)),
    potential,
    range
  }
}
