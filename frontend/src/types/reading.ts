/** 发酵读数：逐日记录比重、温度与糖度 */
export interface Reading {
  id: string
  /** 所属批次 */
  batchId: string
  /** 记录日期 YYYY-MM-DD */
  date: string
  /** 比重（SG） */
  gravity: number
  /** 温度 ℃ */
  tempC: number
  /** 糖度 °Bx */
  brix: number
}

/** 趋势点：在读数基础上派生下降速率与超温标记 */
export interface ReadingPoint extends Reading {
  /** 相对上一条读数的比重日下降速率 */
  declinePerDay: number
  /** 是否超温（> 30 ℃） */
  overTemp: boolean
}

/** 超温阈值 ℃ */
export const OVER_TEMP_C = 30
/** 发酵停滞判定：连续 2 日比重下降 < 0.002 视为停滞 */
export const STUCK_DECLINE_THRESHOLD = 0.002

export function createEmptyReading(): Omit<Reading, 'id'> {
  return { batchId: '', date: new Date().toISOString().slice(0, 10), gravity: 1.09, tempC: 24, brix: 22 }
}
