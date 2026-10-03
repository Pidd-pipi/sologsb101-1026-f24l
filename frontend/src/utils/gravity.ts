/**
 * 比重 / 糖度换算与发酵阶段判定
 * 供批次读数页、品评页与批次档案导出复用。
 */
import { OVER_TEMP_C } from '../types/reading'

/** 糖度（°Bx）→ 比重（SG） */
export function brixToSg(brix: number): number {
  const safe = Math.max(0, Math.min(40, brix))
  return 1 + safe / (258.6 - (safe / 258.2) * 227.1)
}

/** 比重（SG）→ 糖度（°Bx），用二分反解，精度 0.001 */
export function sgToBrix(sg: number): number {
  let low = 0
  let high = 40
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2
    if (brixToSg(mid) < sg) low = mid
    else high = mid
  }
  return Number(((low + high) / 2).toFixed(2))
}

/** 由当前比重估算潜在酒精度（%vol） */
export function potentialAbv(sg: number): number {
  return Number(Math.max(0, (sg - 1) * 131).toFixed(2))
}

/** 由起止比重计算实际酒精度（%vol） */
export function abvFromSg(og: number, fg: number): number {
  return Number(Math.max(0, (og - fg) * 131).toFixed(2))
}

/** 表观发酵度（%） */
export function apparentAttenuation(og: number, fg: number): number {
  if (og <= 1) return 0
  return Number((((og - fg) / (og - 1)) * 100).toFixed(1))
}

/** 是否超温 */
export function isOverTemp(tempC: number): boolean {
  return tempC > OVER_TEMP_C
}

/** 发酵阶段阈值：按比重划分 */
export type FermentStage = '起酵' | '主发酵' | '后发酵' | '结束'

export function fermentationStage(sg: number): FermentStage {
  if (sg >= 1.06) return '起酵'
  if (sg >= 1.02) return '主发酵'
  if (sg >= 1.0) return '后发酵'
  return '结束'
}

/** 阶段 → Element Plus tag 主题色 */
export function stageTone(stage: FermentStage): 'primary' | 'success' | 'warning' | 'info' {
  switch (stage) {
    case '起酵':
      return 'primary'
    case '主发酵':
      return 'warning'
    case '后发酵':
      return 'success'
    default:
      return 'info'
  }
}

/** 阶段 → 展示用底色（也用于自绘趋势条） */
export const STAGE_COLORS: Record<FermentStage, string> = {
  起酵: '#8e6bbf',
  主发酵: '#c9863c',
  后发酵: '#3f8f6b',
  结束: '#7a8b99'
}

/** 比重日下降速率：返回 (prev - next) / 天数，prev 为较早读数 */
export function gravityDeclinePerDay(prevSg: number, nextSg: number, days: number): number {
  if (days <= 0) return 0
  return Number(((prevSg - nextSg) / days).toFixed(4))
}
