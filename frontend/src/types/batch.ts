/** 批次状态：酒精发酵 → 苹乳发酵 → 已出罐 */
export type BatchState = '酒精发酵' | '苹乳发酵' | '已出罐'

/** 入罐批次：绑定地块与发酵罐 */
export interface Batch {
  id: string
  /** 地块 id */
  parcelId: string
  /** 发酵罐 id */
  tankId: string
  /** 采收日期 YYYY-MM-DD */
  harvestDate: string
  /** 入罐量（L） */
  volumeL: number
  /** 入罐糖度（°Bx） */
  brix: number
  /** 批次状态 */
  state: BatchState
  /** 最近一次作业时间（由作业完成回写） */
  lastOperationAt: string | null
}

export const BATCH_STATES: BatchState[] = ['酒精发酵', '苹乳发酵', '已出罐']

/** 是否仍在罐内（占用罐位） */
export function isBatchActive(batch: Pick<Batch, 'state'>): boolean {
  return batch.state !== '已出罐'
}

export function createEmptyBatch(): Omit<Batch, 'id' | 'lastOperationAt'> {
  return {
    parcelId: '',
    tankId: '',
    harvestDate: new Date().toISOString().slice(0, 10),
    volumeL: 500,
    brix: 23,
    state: '酒精发酵'
  }
}
