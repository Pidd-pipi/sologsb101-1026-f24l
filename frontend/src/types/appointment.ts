/** 预约状态：预约中 → 已入罐 / 已取消 / 待复核 */
export type AppointmentState = '预约中' | '已入罐' | '已取消' | '待复核'

/**
 * 到厂预约：采收队还在路上时，先按地块采收量占住发酵罐容量。
 * 一条预约就是一份「容量承诺」——总预留不得超过罐剩余容量。
 */
export interface Appointment {
  id: string
  /** 地块 id */
  parcelId: string
  /** 预约罐位 id */
  tankId: string
  /** 预定到厂 / 采收日期 YYYY-MM-DD */
  harvestDate: string
  /** 预约量（L） */
  volumeL: number
  /** 预约状态 */
  state: AppointmentState
  /** 排队序号（FIFO，先提交的占住） */
  seq: number
  /** 承诺版本号：升级后补承诺再排队 */
  commitmentVersion: number
  /** 入罐后关联的批次 id */
  batchId: string | null
  /** 待复核原因（容量不足 / 罐位清洗中 / 罐位已取消） */
  reviewReason: string | null
  /** 备注 */
  note: string
}

export const APPOINTMENT_STATES: AppointmentState[] = ['预约中', '已入罐', '已取消', '待复核']

/** 是否仍占着容量（预约中） */
export function isAppointmentActive(row: Pick<Appointment, 'state'>): boolean {
  return row.state === '预约中'
}

export function createEmptyAppointment(): Omit<
  Appointment,
  'id' | 'seq' | 'commitmentVersion' | 'batchId' | 'reviewReason'
> {
  return {
    parcelId: '',
    tankId: '',
    harvestDate: new Date().toISOString().slice(0, 10),
    volumeL: 500,
    state: '预约中',
    note: ''
  }
}
