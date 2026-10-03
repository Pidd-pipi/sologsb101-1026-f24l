/**
 * 容量承诺计算：罐剩余容量 = 容量 - 实际在罐量 - 已预留量。
 * 纯函数，不触碰 Dexie；页面与 store 用它派生「剩余可约」与「差多少升」。
 */
import type { TankRow, BatchRow, AppointmentRow } from './db'

export interface TankCapacity {
  tankId: string
  capacityL: number
  /** 实际在罐量（在罐批次累计） */
  actualL: number
  /** 已预留量（预约中累计） */
  reservedL: number
  /** 剩余可约 = 容量 - 实际 - 预留 */
  remainingL: number
  /** 已用 = 实际 + 预留 */
  usedL: number
  /** 利用率 0-100 */
  utilization: number
  /** 是否可约（罐位非清洗中且还有剩余） */
  bookable: boolean
}

/** 计算某罐的容量台账 */
export function computeTankCapacity(
  tank: TankRow,
  batches: BatchRow[],
  appointments: AppointmentRow[]
): TankCapacity {
  const actualL = batches
    .filter((batch) => batch.tankId === tank.id && batch.state !== '已出罐')
    .reduce((sum, batch) => sum + batch.volumeL, 0)
  const reservedL = appointments
    .filter((apt) => apt.tankId === tank.id && apt.state === '预约中')
    .reduce((sum, apt) => sum + apt.volumeL, 0)
  const usedL = actualL + reservedL
  const remainingL = tank.capacityL - usedL
  return {
    tankId: tank.id,
    capacityL: tank.capacityL,
    actualL,
    reservedL,
    remainingL,
    usedL,
    utilization: tank.capacityL > 0 ? Math.round((usedL / tank.capacityL) * 100) : 0,
    bookable: tank.state !== '清洗中' && remainingL > 0
  }
}

/** 预约某罐的差量（>0 表示容量不足，差多少升） */
export function shortageOf(cap: TankCapacity, wantL: number): number {
  return Math.max(0, wantL - cap.remainingL)
}

/** 批量计算多罐容量台账 */
export function computeTankCapacities(
  tanks: TankRow[],
  batches: BatchRow[],
  appointments: AppointmentRow[]
): TankCapacity[] {
  return tanks.map((tank) => computeTankCapacity(tank, batches, appointments))
}
