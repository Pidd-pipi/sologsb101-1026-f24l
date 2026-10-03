/**
 * 容量承诺与排队引擎（纯函数，不触碰 IndexedDB）。
 *
 * 规则：
 * 1. 每个罐的可承诺容量 = 罐容量 − 该罐在罐批次的实际入罐量；
 * 2. 预约按提交时间先到先得排队，已承诺/排队中的预约按序挂账容量，总预留不超剩余容量；
 * 3. 罐在「清洗中」时容量够也只能排队，洗罐完成后重算升为已承诺；
 * 4. 重算后排不下的单退「待复核」，后续腾退后再按提交顺序补进来；
 * 5. 新提交的单若抢不到容量则留「草稿」，shortfallL 为负，页面直接展示「差多少升」。
 */
import type { Tank } from '@/types/tank'
import type { Batch } from '@/types/batch'
import type { Reservation, ReservationStatus } from '@/types/reservation'
import { RESERVATION_QUEUE_STATUSES } from '@/types/reservation'

/** 参与占容量 / 排队的在罐批次判定（与 batch.isBatchActive 保持一致） */
export function isActiveBatch(batch: Pick<Batch, 'state'>): boolean {
  return batch.state !== '已出罐'
}

/** 该罐在罐批次的实际占用量（L） */
export function actualVolumeOnTank(tankId: string, batches: Pick<Batch, 'tankId' | 'state' | 'volumeL'>[]): number {
  return batches
    .filter((batch) => batch.tankId === tankId && isActiveBatch(batch))
    .reduce((sum, batch) => sum + batch.volumeL, 0)
}

/** 该罐当前可承诺的剩余容量（L，不含任何预约挂账） */
export function freeCapacity(tank: Pick<Tank, 'id' | 'capacityL'>, batches: Pick<Batch, 'tankId' | 'state' | 'volumeL'>[]): number {
  return tank.capacityL - actualVolumeOnTank(tank.id, batches)
}

/** 容量够时按罐位状态给出的预约状态：清洗中只能排队，其它直接承诺 */
export function holdStatusForTank(tank: Pick<Tank, 'state'>): ReservationStatus {
  return tank.state === '清洗中' ? '排队中' : '已承诺'
}

/** 容量判定结果 */
export interface CommitmentVerdict {
  /** 是否放得下 */
  fits: boolean
  /** 判定后的状态 */
  status: ReservationStatus
  /**
   * 差量（L）：
   * 放得下为占住后罐内余量；放不下为还差的升数（负数），页面取 -shortfallL 展示
   */
  shortfallL: number
  /** 排队序号（放得下时给出，否则 0） */
  seq: number
  reason: string
}

/** 同罐参与排队重算的预约，按提交时间先到先得（同刻按 id 兜底，保证多标签页结果一致） */
export function sortBySubmission<R extends Pick<Reservation, 'submittedAt' | 'id'>>(list: R[]): R[] {
  return [...list].sort((a, b) => a.submittedAt - b.submittedAt || a.id.localeCompare(b.id))
}

/**
 * 模拟一个新提交抢罐：不改变已有预约，返回它能否占住、该落什么状态。
 * 已承诺/排队中的既有预约都占用容量；待复核单不占容量（已被挤出）。
 * excludeId 用于编辑/重新提交已有单时排除自身，避免把自己的预留重复计入。
 */
export function evaluateSubmission(
  tank: Pick<Tank, 'id' | 'capacityL' | 'state'>,
  batches: Pick<Batch, 'tankId' | 'state' | 'volumeL'>[],
  reservations: Pick<Reservation, 'tankId' | 'status' | 'forecastVolumeL' | 'submittedAt' | 'id'>[],
  volumeL: number,
  _submittedAt: number,
  excludeId?: string
): CommitmentVerdict {
  const available = freeCapacity(tank, batches)
  const held = sortBySubmission(
    reservations.filter(
      (item) =>
        item.tankId === tank.id &&
        (item.status === '已承诺' || item.status === '排队中') &&
        item.id !== excludeId
    )
  ).reduce((sum, item) => sum + item.forecastVolumeL, 0)
  const nextSeq =
    reservations.filter(
      (item) =>
        item.tankId === tank.id &&
        (item.status === '已承诺' || item.status === '排队中') &&
        item.id !== excludeId
    ).length + 1
  const leftAfter = available - held - volumeL
  if (leftAfter >= 0) {
    const status = holdStatusForTank(tank)
    return {
      fits: true,
      status,
      shortfallL: leftAfter,
      seq: nextSeq,
      reason: status === '排队中' ? '罐位清洗中，洗罐完成后按序入罐' : '容量充足，已占住罐位'
    }
  }
  return {
    fits: false,
    status: '草稿',
    shortfallL: leftAfter,
    seq: 0,
    reason: `容量不足：占住后还差 ${-leftAfter}L，已留草稿`
  }
}

/** 重算后单条预约的变更 */
export interface RecomputeChange {
  id: string
  status: ReservationStatus
  seq: number
  shortfallL: number
  reason: string
}

function reasonFor(status: ReservationStatus, leftAfter: number): string {
  if (status === '排队中') return '罐位清洗中，洗罐完成后按序入罐'
  if (status === '已承诺') return '容量充足，承诺生效'
  return `重算后容量不足，还差 ${-leftAfter}L，退回复核`
}

/**
 * 重算单个罐的预约队列。
 * 已承诺/排队中/待复核的单都参与，按提交顺序依次尝试挂账：
 * 放得下 → 已承诺（或清洗中的排队中）；放不下 → 待复核并记录差量。
 * 只返回状态/差量确有变化需要写库的单（调用方负责提交事务与承诺版本号 +1）。
 */
export function recomputeTankQueue(
  tank: Pick<Tank, 'id' | 'capacityL' | 'state'>,
  batches: Pick<Batch, 'tankId' | 'state' | 'volumeL'>[],
  reservations: Pick<
    Reservation,
    'id' | 'tankId' | 'status' | 'forecastVolumeL' | 'submittedAt' | 'seq' | 'shortfallL' | 'reason'
  >[]
): RecomputeChange[] {
  const available = freeCapacity(tank, batches)
  const participants = sortBySubmission(
    reservations.filter((item) => item.tankId === tank.id && RESERVATION_QUEUE_STATUSES.includes(item.status))
  )
  let held = 0
  let seq = 0
  const changes: RecomputeChange[] = []
  for (const item of participants) {
    const leftAfter = available - held - item.forecastVolumeL
    if (leftAfter >= 0) {
      held += item.forecastVolumeL
      seq += 1
      const status = holdStatusForTank(tank)
      if (
        item.status !== status ||
        item.seq !== seq ||
        item.shortfallL !== leftAfter ||
        item.reason !== reasonFor(status, leftAfter)
      ) {
        changes.push({ id: item.id, status, seq, shortfallL: leftAfter, reason: reasonFor(status, leftAfter) })
      }
    } else {
      const reason = reasonFor('待复核', leftAfter)
      if (item.status !== '待复核' || item.seq !== 0 || item.shortfallL !== leftAfter || item.reason !== reason) {
        changes.push({ id: item.id, status: '待复核', seq: 0, shortfallL: leftAfter, reason })
      }
    }
  }
  return changes
}

/** 全罐重算：汇总所有罐的变更（容量/罐位变动后统一调用） */
export function recomputeAllQueues(
  tanks: Pick<Tank, 'id' | 'capacityL' | 'state'>[],
  batches: Pick<Batch, 'tankId' | 'state' | 'volumeL'>[],
  reservations: Pick<
    Reservation,
    'id' | 'tankId' | 'status' | 'forecastVolumeL' | 'submittedAt' | 'seq' | 'shortfallL' | 'reason'
  >[]
): RecomputeChange[] {
  return tanks.flatMap((tank) => recomputeTankQueue(tank, batches, reservations))
}

/** 罐位看板展示用的容量汇总 */
export interface TankCommitmentSummary {
  tankId: string
  /** 实际在罐量 */
  actualL: number
  /** 已承诺/排队预留量 */
  reservedL: number
  /** 剩余可承诺容量 */
  freeL: number
  /** 总预留是否超容量（实际超量时为 true） */
  overbooked: boolean
}

export function summarizeTank(
  tank: Pick<Tank, 'id' | 'capacityL'>,
  batches: Pick<Batch, 'tankId' | 'state' | 'volumeL'>[],
  reservations: Pick<Reservation, 'tankId' | 'status' | 'forecastVolumeL'>[]
): TankCommitmentSummary {
  const actualL = actualVolumeOnTank(tank.id, batches)
  const reservedL = reservations
    .filter((item) => item.tankId === tank.id && (item.status === '已承诺' || item.status === '排队中'))
    .reduce((sum, item) => sum + item.forecastVolumeL, 0)
  const freeL = tank.capacityL - actualL - reservedL
  return { tankId: tank.id, actualL, reservedL, freeL, overbooked: actualL > tank.capacityL || freeL < 0 }
}
