/** 作业类型 */
export type OperationType = '倒罐' | '压帽' | '淋皮'
/** 作业状态 */
export type OperationState = '计划' | '已完成'

/** 车间作业：倒罐 / 压帽 / 淋皮 */
export interface Operation {
  id: string
  /** 所属批次 */
  batchId: string
  /** 作业类型 */
  type: OperationType
  /** 计划日期 YYYY-MM-DD */
  date: string
  /** 时长（分钟） */
  durationMin: number
  /** 操作人 */
  operator: string
  /** 作业状态 */
  state: OperationState
  /** 拖拽调序后的先后次序（从 1 开始） */
  seq: number
}

export const OPERATION_TYPES: OperationType[] = ['倒罐', '压帽', '淋皮']
export const OPERATION_STATES: OperationState[] = ['计划', '已完成']

export function createEmptyOperation(): Omit<Operation, 'id' | 'seq'> {
  return {
    batchId: '',
    type: '倒罐',
    date: new Date().toISOString().slice(0, 10),
    durationMin: 45,
    operator: '',
    state: '计划'
  }
}
