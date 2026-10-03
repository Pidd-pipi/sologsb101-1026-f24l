/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 / 到厂预约 八张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { Appointment } from '../types/appointment'
import { nowIso, createId } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 1

/** 容量承诺版本号：旧数据升级后补承诺再排队时盖此版本 */
export const COMMITMENT_VERSION = 1

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type ReadingRow = Reading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned
export type AppointmentRow = Appointment & Revisioned

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  appointments!: Table<AppointmentRow, string>

  constructor() {
    super(DB_NAME)

    const v1Stores = {
      parcels: 'id, name, variety, aspect, updatedAt',
      tanks: 'id, code, material, tempControl, state, updatedAt',
      batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
      readings: 'id, batchId, date, updatedAt',
      operations: 'id, batchId, type, state, date, seq, updatedAt',
      mlfs: 'id, batchId, state, updatedAt',
      tastings: 'id, batchId, date, verdict, updatedAt'
    }

    this.version(1)
      .stores(v1Stores)
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    // v2：新增到厂预约表；为历史地块/罐/批次补承诺版本号，再排队
    this.version(2)
      .stores({
        ...v1Stores,
        appointments: 'id, parcelId, tankId, state, seq, commitmentVersion, harvestDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 补承诺版本：旧数据没有「容量承诺」概念，统一盖当前承诺版本号
        const tableNames = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.commitmentVersion !== 'number') row.commitmentVersion = COMMITMENT_VERSION
            })
        }
        // appointments 表为新增空表，无需排队；initDatabase 打开后会再做一次幂等重算
      })
  }
}

export const db = new GbWineTankDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
  // 升级后补承诺再排队：打开库后对全部有预约的罐位做一次幂等重算
  await recalcAllQueues()
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(row)
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await db.parcels.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.appointments],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.appointments.where('parcelId').equals(id).delete()
      await db.parcels.delete(id)
    }
  )
}

/* ------------------------------ 发酵罐 ------------------------------ */

export async function listTanks(): Promise<TankRow[]> {
  const rows = await db.tanks.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putTank(row: TankRow): Promise<void> {
  await db.tanks.put(row)
}

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await db.tanks.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTank(id: string): Promise<void> {
  const active = await db.batches.where('tankId').equals(id).filter((b) => b.state !== '已出罐').count()
  if (active > 0) {
    throw new Error('该罐仍有在罐批次，请先出罐或改绑其它罐位')
  }
  await db.transaction('rw', [db.tanks, db.batches, db.appointments], async () => {
    // 罐位取消：其下预约中全部退回复核
    await db.appointments
      .where('tankId')
      .equals(id)
      .filter((apt) => apt.state === '预约中')
      .modify({ state: '待复核', reviewReason: '罐位已取消', updatedAt: Date.now() })
    await db.batches.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 入罐批次 ------------------------------ */

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(row)
}

export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  await db.batches.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 内部级联删除：清掉批次下属全部子表数据 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId) {
    await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
  }
  await db.batches.delete(batchId)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks],
    async () => {
      await cascadeRemoveBatch(id)
    }
  )
}

/** 出罐：批次置为已出罐并自动释放罐位，重算排队（腾出容量可恢复待复核预约） */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.tanks, db.appointments], async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    const tankId = batch.tankId
    if (tankId) {
      await db.tanks.update(tankId, { state: '空闲', updatedAt: Date.now() } as never)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: Date.now() } as never)
    // 出罐腾出容量：重算该罐排队，排得下的待复核预约恢复为预约中
    if (tankId) await _recalcTankQueue(tankId)
  })
}

/** 校验罐位是否可以分配给指定批次 */
export async function assertTankAssignable(tankId: string, batchId: string | null): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const occupants = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐' && b.id !== batchId)
    .toArray()
  if (occupants.length > 0) {
    throw new Error(`罐 ${tank.code} 已被批次占用，禁止重复分配`)
  }
}

/** 校验直接入罐量不超过罐剩余容量（实际在罐 + 已预留 + 本次 ≤ 容量） */
export async function assertCapacityForBatch(tankId: string, volumeL: number): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  const actual = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐')
    .toArray()
  const actualL = actual.reduce((sum, b) => sum + b.volumeL, 0)
  const reserved = await db.appointments
    .where('tankId')
    .equals(tankId)
    .filter((a) => a.state === '预约中')
    .toArray()
  const reservedL = reserved.reduce((sum, a) => sum + a.volumeL, 0)
  const remainingL = tank.capacityL - actualL - reservedL
  if (volumeL > remainingL) {
    throw new Error(`罐 ${tank.code} 剩余可约 ${remainingL}L，本次入罐量超 ${volumeL - remainingL}L，请先预约或调小入罐量`)
  }
}

/* ------------------------------ 到厂预约（容量承诺） ------------------------------ */

export async function listAppointments(): Promise<AppointmentRow[]> {
  const rows = await db.appointments.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
}

export async function putAppointment(row: AppointmentRow): Promise<void> {
  await db.appointments.put(row)
}

export async function updateAppointment(id: string, patch: Partial<Appointment>): Promise<void> {
  await db.appointments.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeAppointment(id: string): Promise<void> {
  await db.appointments.delete(id)
}

/** 预约提交结果：成功占住 或 容量不足（带差量） */
export type BookAppointmentResult =
  | { ok: true; appointment: AppointmentRow }
  | { ok: false; shortageL: number; remainingL: number; reason: string }

/**
 * 到厂预约：在 read-write 事务内重新计算罐剩余容量，先提交的占住。
 * IndexedDB 会串行化重叠的读写事务，因此两个标签同时提交同一罐时，
 * 后一个事务能读到前一个事务已提交的预留量，从而正确判负（差多少升）。
 */
export async function bookAppointment(input: {
  parcelId: string
  tankId: string
  harvestDate: string
  volumeL: number
  note: string
}): Promise<BookAppointmentResult> {
  return await db.transaction('rw', [db.appointments, db.tanks, db.batches], async () => {
    const tank = await db.tanks.get(input.tankId)
    if (!tank) throw new Error('发酵罐不存在')
    if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可预约`)
    if (input.volumeL <= 0) throw new Error('预约量必须大于 0')

    // 事务内重算剩余容量（不依赖页面的过期快照）
    const actual = await db.batches
      .where('tankId')
      .equals(input.tankId)
      .filter((b) => b.state !== '已出罐')
      .toArray()
    const actualL = actual.reduce((sum, b) => sum + b.volumeL, 0)
    const reserved = await db.appointments
      .where('tankId')
      .equals(input.tankId)
      .filter((a) => a.state === '预约中')
      .toArray()
    const reservedL = reserved.reduce((sum, a) => sum + a.volumeL, 0)
    const remainingL = tank.capacityL - actualL - reservedL

    if (input.volumeL > remainingL) {
      const shortageL = input.volumeL - remainingL
      return {
        ok: false,
        shortageL,
        remainingL,
        reason: `罐 ${tank.code} 剩余可约 ${remainingL}L，差 ${shortageL}L`
      }
    }

    // 占住：取该罐最大排队序号 +1（FIFO，先提交的占住）
    const maxSeq = reserved.reduce((max, a) => Math.max(max, a.seq), 0)
    const now = Date.now()
    const appointment: AppointmentRow = {
      id: createId('apt'),
      parcelId: input.parcelId,
      tankId: input.tankId,
      harvestDate: input.harvestDate,
      volumeL: input.volumeL,
      state: '预约中',
      seq: maxSeq + 1,
      commitmentVersion: COMMITMENT_VERSION,
      batchId: null,
      reviewReason: null,
      note: input.note,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }
    await db.appointments.add(appointment)
    return { ok: true, appointment }
  })
}

/** 内部：在当前事务内重算某罐排队（FIFO）。排不下的预约中退回复核；已复核且现在排得下的恢复预约中 */
async function _recalcTankQueue(
  tankId: string
): Promise<{ kept: number; demoted: number; promoted: number }> {
  const tank = await db.tanks.get(tankId)
  const tankAvailable = !!tank && tank.state !== '清洗中'

  const actual = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐')
    .toArray()
  const actualL = actual.reduce((sum, b) => sum + b.volumeL, 0)
  let remaining = tankAvailable && tank ? tank.capacityL - actualL : 0

  const queued = await db.appointments
    .where('tankId')
    .equals(tankId)
    .filter((a) => a.state === '预约中' || a.state === '待复核')
    .toArray()
  queued.sort((a, b) => a.seq - b.seq)

  let demoted = 0
  let promoted = 0
  for (const apt of queued) {
    if (apt.state === '预约中') {
      if (tankAvailable && apt.volumeL <= remaining) {
        remaining -= apt.volumeL
      } else {
        demoted += 1
        const shortage = tankAvailable ? apt.volumeL - remaining : apt.volumeL
        await db.appointments.update(apt.id, {
          state: '待复核',
          reviewReason: tankAvailable ? `容量不足，差 ${shortage}L` : '罐位不可用',
          updatedAt: Date.now()
        } as never)
      }
    } else if (tankAvailable && apt.volumeL <= remaining) {
      // 待复核：现在排得下且罐位可用 → 恢复预约中
      remaining -= apt.volumeL
      promoted += 1
      await db.appointments.update(apt.id, {
        state: '预约中',
        reviewReason: null,
        updatedAt: Date.now()
      } as never)
    }
  }
  return { kept: queued.length - demoted, demoted, promoted }
}

/** 重算某罐排队（容量不足的退回复核，排得下的保留/恢复） */
export async function recalcTankQueue(
  tankId: string
): Promise<{ kept: number; demoted: number; promoted: number }> {
  return await db.transaction('rw', [db.appointments, db.tanks, db.batches], async () => {
    return await _recalcTankQueue(tankId)
  })
}

/** 重算全部有预约的罐位（升级后补承诺再排队时调用，幂等） */
export async function recalcAllQueues(): Promise<void> {
  const rows = await db.appointments.toArray()
  const tankIds = [...new Set(rows.map((a) => a.tankId))]
  for (const tankId of tankIds) {
    await recalcTankQueue(tankId)
  }
}

/**
 * 预约入罐：把一条预约转为真实批次。
 * 实际入罐量可能与预约量有出入；若因此超量，重算该罐排队（排不下的退回复核）。
 */
export async function convertAppointmentToBatch(
  appointmentId: string,
  payload: { harvestDate: string; volumeL: number; brix: number }
): Promise<{ batchId: string; overCapacity: boolean }> {
  return await db.transaction('rw', [db.appointments, db.batches, db.tanks], async () => {
    const apt = await db.appointments.get(appointmentId)
    if (!apt) throw new Error('预约不存在')
    if (apt.state !== '预约中') throw new Error('仅「预约中」的预约可入罐')

    const tankId = apt.tankId
    const now = Date.now()
    const batchId = createId('batch')
    await db.batches.add({
      id: batchId,
      parcelId: apt.parcelId,
      tankId,
      harvestDate: payload.harvestDate,
      volumeL: payload.volumeL,
      brix: payload.brix,
      state: '酒精发酵',
      lastOperationAt: null,
      commitmentVersion: COMMITMENT_VERSION,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    } as BatchRow)
    await db.appointments.update(appointmentId, {
      state: '已入罐',
      batchId,
      reviewReason: null,
      updatedAt: now
    } as never)
    await db.tanks.update(tankId, { state: '在用', updatedAt: now } as never)

    // 超量校验：实际在罐是否超过容量
    const tank = await db.tanks.get(tankId)
    const actual = await db.batches
      .where('tankId')
      .equals(tankId)
      .filter((b) => b.state !== '已出罐')
      .toArray()
    const actualL = actual.reduce((sum, b) => sum + b.volumeL, 0)
    const overCapacity = !!tank && actualL > tank.capacityL
    if (overCapacity) {
      // 实际入罐超量：重算排队，排不下的退回复核
      await _recalcTankQueue(tankId)
    }
    return { batchId, overCapacity }
  })
}

/* ------------------------------ 发酵读数 ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(row)
}

export async function updateReading(id: string, patch: Partial<Reading>): Promise<void> {
  await db.readings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id)
}

/* -------------------------------- 作业 -------------------------------- */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

export async function putOperation(row: OperationRow): Promise<void> {
  await db.operations.put(row)
}

export async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
  await db.operations.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeOperation(id: string): Promise<void> {
  await db.operations.delete(id)
}

/** 批量写回拖拽后的作业顺序 */
export async function reorderOperations(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.operations, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.operations.update(orderedIds[index], { seq: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 作业完成：置为已完成并回写批次的最近作业时间 */
export async function completeOperation(id: string): Promise<void> {
  await db.transaction('rw', db.operations, db.batches, async () => {
    const operation = await db.operations.get(id)
    if (!operation) throw new Error('作业不存在')
    await db.operations.update(id, { state: '已完成', updatedAt: Date.now() } as never)
    await db.batches.update(operation.batchId, { lastOperationAt: nowIso(), updatedAt: Date.now() } as never)
  })
}

/** 某个批次现有作业的最大序号 */
export async function nextOperationSeq(batchId: string): Promise<number> {
  const rows = await db.operations.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(row)
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await db.mlfs.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeMlf(id: string): Promise<void> {
  await db.mlfs.delete(id)
}

/* ------------------------------ 品评调配 ------------------------------ */

export async function listTastings(): Promise<TastingRow[]> {
  const rows = await db.tastings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putTasting(row: TastingRow): Promise<void> {
  await db.tastings.put(row)
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await db.tastings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  readings: Reading[]
  operations: Operation[]
  mlfs: Mlf[]
  tastings: Tasting[]
  appointments: Appointment[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, appointments] = await Promise.all([
    db.parcels.toArray(),
    db.tanks.toArray(),
    db.batches.toArray(),
    db.readings.toArray(),
    db.operations.toArray(),
    db.mlfs.toArray(),
    db.tastings.toArray(),
    db.appointments.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow),
    appointments: appointments.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.appointments],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.appointments.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
      await db.appointments.bulkPut((snapshot.appointments ?? []).map(stamp))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.appointments],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.appointments.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, appointments] = await Promise.all([
    db.parcels.count(),
    db.tanks.count(),
    db.batches.count(),
    db.readings.count(),
    db.operations.count(),
    db.mlfs.count(),
    db.tastings.count(),
    db.appointments.count()
  ])
  return { parcels, tanks, batches, readings, operations, mlfs, tastings, appointments }
}
