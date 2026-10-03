/**
 * 到厂预约与容量承诺。
 * 采收队还在路上时，车间按电话先为地块采收量占发酵罐：
 * - 总预留（在罐实际量 + 已承诺/排队预留）不得超过罐剩余容量
 * - 多个标签页同时抢同一罐时，先提交的「已承诺」占住，后提交的留「草稿」并显示差多少升
 * - 实际入罐超量 / 罐转清洗 / 取消后重算排队，排不下的入罐单退回「待复核」
 */

/** 预约单状态 */
export type ReservationStatus =
  | '草稿'
  | '已承诺'
  | '排队中'
  | '待复核'
  | '已入罐'
  | '已取消'

/** 失败写入（pending outbox）的动作类型：写入失败后保留预约/草稿，可重试 */
export type PendingWriteKind = '提交预约' | '到厂登记' | '取消预约'

/** 到厂预约单（电话预约 / 容量承诺 / 排队 / 草稿） */
export interface Reservation {
  id: string
  /** 地块 id：预约源头是一次地块采收 */
  parcelId: string
  /** 预约的发酵罐 id */
  tankId: string
  /** 预计到厂时间 YYYY-MM-DD HH:mm（电话里报的点） */
  expectedAt: string
  /** 电话预报采收量（L），用于先占罐 */
  forecastVolumeL: number
  /** 联系人/采收队（电话来源备注） */
  contact: string
  /** 备注 */
  note: string
  /** 状态机 */
  status: ReservationStatus
  /** 提交抢罐时间（先到先得的排序依据） */
  submittedAt: number
  /** 承诺时间（占住罐容量的时刻） */
  committedAt: number | null
  /** 罐内排队序号（同罐按 submittedAt 递增） */
  seq: number
  /**
   * 最近一次容量/罐位判定的差量（L）：
   * 正数表示还剩多少升，负数表示差多少升才能放下（草稿/待复核页直接展示）
   */
  shortfallL: number
  /** 最近一次状态变化原因（清洗中 / 容量不足 / 超量 …） */
  reason: string
  /** 实际到厂量（L，到厂登记时填） */
  actualVolumeL: number | null
  /** 实际到厂日期 YYYY-MM-DD */
  arrivedAt: string | null
  /** 实际糖度（°Bx，到厂登记时填） */
  actualBrix: number | null
  /** 到厂后生成的入罐批次 id */
  batchId: string | null
  /** 承诺版本号：每次排队重算 +1，旧数据升级后补基线版本再排队 */
  commitmentVersion: number
}

/** 失败写入的补偿记录：主事务失败时把动作完整保留下来，重试时原样回放 */
export interface PendingWrite {
  id: string
  /** 动作类型 */
  kind: PendingWriteKind
  /** 关联预约单 id（可能尚未落库，配合 payload.tempId 幂等回放） */
  reservationId: string
  /** 原始动作载荷（预约表单 / 到厂实测量 等） */
  payload: Record<string, unknown>
  /** 最近一次失败原因 */
  lastError: string
  /** 已尝试次数 */
  attempts: number
}

export const RESERVATION_STATUSES: ReservationStatus[] = [
  '草稿',
  '已承诺',
  '排队中',
  '待复核',
  '已入罐',
  '已取消'
]

/** 仍占罐位容量的预约状态（已承诺占住；排队中等罐洗完，容量先挂账） */
export const RESERVATION_HOLD_STATUSES: ReservationStatus[] = ['已承诺', '排队中']

/** 还参与排队重算的状态（草稿与终态不参与） */
export const RESERVATION_QUEUE_STATUSES: ReservationStatus[] = ['已承诺', '排队中', '待复核']

/** 可做到厂登记的状态 */
export const RESERVATION_ARRIVABLE_STATUSES: ReservationStatus[] = ['已承诺', '待复核']

export const PENDING_WRITE_KINDS: PendingWriteKind[] = ['提交预约', '到厂登记', '取消预约']

export function createEmptyReservation(): Omit<
  Reservation,
  | 'id'
  | 'status'
  | 'submittedAt'
  | 'committedAt'
  | 'seq'
  | 'shortfallL'
  | 'reason'
  | 'actualVolumeL'
  | 'arrivedAt'
  | 'actualBrix'
  | 'batchId'
  | 'commitmentVersion'
> {
  return {
    parcelId: '',
    tankId: '',
    expectedAt: new Date().toISOString().slice(0, 16),
    forecastVolumeL: 500,
    contact: '',
    note: ''
  }
}
