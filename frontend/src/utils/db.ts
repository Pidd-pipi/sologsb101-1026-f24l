/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 / 到厂预约 / 失败写入 分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 *
 * v2：新增 reservations（到厂预约与容量承诺）、pendingWrites（写入失败补偿）、
 * meta（承诺版本号 / 故障注入开关）；旧数据升级后补承诺版本号并重排队。
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { PendingWrite, PendingWriteKind, Reservation } from '../types/reservation'
import { nowIso, createId } from './uuid'
import { seedDatabase } from './seed'
import { evaluateSubmission, recomputeAllQueues } from './commitment'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 1

/** 承诺队列版本号在 meta 表中的键 */
export const META_COMMITMENT_VERSION = 'commitmentVersion'
/** 提交预约故障注入开关（演示「写入失败 → 留草稿 → 重试」） */
export const META_FAULT_COMMIT = 'faultCommit'
/** 到厂登记故障注入开关 */
export const META_FAULT_ARRIVE = 'faultArrive'

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
export type ReservationRow = Reservation & Revisioned
export type PendingWriteRow = PendingWrite & Revisioned

/** meta 表：键值对（承诺版本号、故障开关等） */
export interface MetaRow extends Revisioned {
  key: string
  value: unknown
}

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  reservations!: Table<ReservationRow, string>
  pendingWrites!: Table<PendingWriteRow, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
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

    this.version(2)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt',
        reservations: 'id, parcelId, tankId, status, expectedAt, submittedAt, seq, batchId, commitmentVersion, updatedAt',
        pendingWrites: 'id, reservationId, kind, attempts, updatedAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        // 旧数据升级：补承诺版本号基线，再按当前罐/批次/预约统一重排队
        const now = Date.now()
        await tx.table('meta').put({
          key: META_COMMITMENT_VERSION,
          value: 0,
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        })
        const reservationTable = tx.table<ReservationRow, string>('reservations')
        const exists = await reservationTable.count()
        if (exists === 0) return
        const [tanks, batches] = await Promise.all([
          tx.table<TankRow, string>('tanks').toArray(),
          tx.table<BatchRow, string>('batches').toArray()
        ])
        // 先给历史预约补承诺版本号，并把占容量状态统一打回待复核，再重新排队
        await reservationTable.toCollection().modify((row) => {
          if (typeof row.commitmentVersion !== 'number') row.commitmentVersion = 0
          if (typeof row.seq !== 'number') row.seq = 0
          if (typeof row.shortfallL !== 'number') row.shortfallL = 0
          if (typeof row.reason !== 'string') row.reason = '旧数据升级，等待重新排队'
          if (row.status === '已承诺' || row.status === '排队中' || row.status === '待复核') {
            row.status = '待复核'
          }
        })
        const refreshed = await reservationTable.toArray()
        const changes = recomputeAllQueues(tanks, batches, refreshed)
        if (changes.length > 0) {
          for (const change of changes) {
            await reservationTable.update(change.id, {
              ...change,
              commitmentVersion: 1,
              updatedAt: now
            })
          }
          await tx.table('meta').put({
            key: META_COMMITMENT_VERSION,
            value: 1,
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now
          })
        }
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
}

/* --------------------------- 事务内共用工具 --------------------------- */

const QUEUE_TABLES = [db.reservations, db.batches, db.tanks, db.meta] as const

async function getMetaNumber(key: string, fallback = 0): Promise<number> {
  const row = await db.meta.get(key)
  return typeof row?.value === 'number' ? row.value : fallback
}

async function faultEnabled(key: string): Promise<boolean> {
  const row = await db.meta.get(key)
  return row?.value === true
}

/** 承诺版本号 +1（必须在 rw 事务内调用），返回新版本号 */
async function bumpCommitmentVersion(): Promise<number> {
  const next = (await getMetaNumber(META_COMMITMENT_VERSION, 0)) + 1
  const now = Date.now()
  const existing = await db.meta.get(META_COMMITMENT_VERSION)
  await db.meta.put({
    key: META_COMMITMENT_VERSION,
    value: next,
    revision: ROW_REVISION,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })
  return next
}

/**
 * 按当前罐/批次/预约全量重算排队（必须在含 QUEUE_TABLES 的 rw 事务内调用）。
 * 排不下的单退「待复核」，腾退后再按提交顺序补回；有变更时承诺版本号 +1。
 * 返回新版本号（无变更则返回当前版本）。
 */
async function settleQueues(): Promise<number> {
  const [tanks, batches, reservations] = await Promise.all([
    db.tanks.toArray(),
    db.batches.toArray(),
    db.reservations.toArray()
  ])
  const changes = recomputeAllQueues(tanks, batches, reservations)
  if (changes.length === 0) return getMetaNumber(META_COMMITMENT_VERSION, 0)
  const version = await bumpCommitmentVersion()
  const now = Date.now()
  for (const change of changes) {
    await db.reservations.update(change.id, {
      status: change.status,
      seq: change.seq,
      shortfallL: change.shortfallL,
      reason: change.reason,
      commitmentVersion: version,
      updatedAt: now
    } as never)
  }
  return version
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

/** 删除地块：级联删除其下批次、预约及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.tanks,
      db.reservations,
      db.pendingWrites
    ],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      const reservations = await db.reservations.where('parcelId').equals(id).toArray()
      for (const reservation of reservations) {
        await db.pendingWrites.where('reservationId').equals(reservation.id).delete()
        await db.reservations.delete(reservation.id)
      }
      await db.parcels.delete(id)
    }
  )
  // 预约随地块一起删除可能腾出容量，统一重算其它罐的排队
  await recomputeReservationQueues()
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
  const liveReservations = await db.reservations
    .where('tankId')
    .equals(id)
    .filter((r) => r.status !== '已取消' && r.status !== '已入罐')
    .count()
  if (liveReservations > 0) {
    throw new Error('该罐仍有未完结预约（已承诺/排队/待复核/草稿），请先取消或改约其它罐位')
  }
  await db.transaction('rw', db.tanks, db.batches, async () => {
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

export async function updateBatchRow(id: string, patch: Partial<Batch>): Promise<void> {
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
    [db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, ...QUEUE_TABLES],
    async () => {
      await cascadeRemoveBatch(id)
      await settleQueues()
    }
  )
}

/** 出罐：批次置为已出罐并自动释放罐位，随后重算预约排队（待复核单可能补回） */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.tanks, ...QUEUE_TABLES], async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    if (batch.tankId) {
      await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: Date.now() } as never)
    await settleQueues()
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

/* --------------------------- 到厂预约 / 容量承诺 --------------------------- */

export async function listReservations(): Promise<ReservationRow[]> {
  const rows = await db.reservations.toArray()
  return rows.sort((a, b) => b.submittedAt - a.submittedAt || a.id.localeCompare(b.id))
}

export async function listPendingWrites(): Promise<PendingWriteRow[]> {
  const rows = await db.pendingWrites.toArray()
  return rows.sort((a, b) => a.updatedAt - b.updatedAt)
}

export async function getReservation(id: string): Promise<ReservationRow | undefined> {
  return db.reservations.get(id)
}

export async function getCommitmentVersion(): Promise<number> {
  return getMetaNumber(META_COMMITMENT_VERSION, 0)
}

/** 故障注入开关：true 时对应主事务主动失败，走 outbox 留草稿/待重试 */
export async function setFaultFlag(kind: 'commit' | 'arrive', enabled: boolean): Promise<void> {
  const key = kind === 'commit' ? META_FAULT_COMMIT : META_FAULT_ARRIVE
  const now = Date.now()
  const existing = await db.meta.get(key)
  await db.meta.put({
    key,
    value: enabled,
    revision: ROW_REVISION,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })
}

export async function getFaultFlags(): Promise<{ commit: boolean; arrive: boolean }> {
  const [commit, arrive] = await Promise.all([faultEnabled(META_FAULT_COMMIT), faultEnabled(META_FAULT_ARRIVE)])
  return { commit, arrive }
}

/** 提交预约的入参（id 由调用方生成，失败重试时保持同一身份） */
export interface ReservationInput {
  id: string
  parcelId: string
  tankId: string
  expectedAt: string
  forecastVolumeL: number
  contact: string
  note: string
  /** 提交时刻：先到先得的排序依据，失败重试时沿用原值保持排队顺序 */
  submittedAt: number
}

function buildReservationDraft(input: ReservationInput, shortfallL: number, reason: string, now: number): ReservationRow {
  return {
    ...input,
    status: '草稿',
    committedAt: null,
    seq: 0,
    shortfallL,
    reason,
    actualVolumeL: null,
    arrivedAt: null,
    actualBrix: null,
    batchId: null,
    commitmentVersion: 0,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 抢罐失败后的补偿：把预约单以「草稿」落库，并在 pendingWrites 留一条可重试的提交动作。
 * 主事务已整体回滚，这里独立写入，保证「写入失败后保留预约和草稿并可重试」。
 */
async function persistSubmitFailure(input: ReservationInput, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : '提交写入失败'
  // 草稿上的差量是尽力值，权威差量在重试成功时重算
  let shortfallL = 0
  let reason = `提交写入失败（${message}），已留草稿，可重试`
  try {
    const [tank, batches, reservations] = await Promise.all([
      db.tanks.get(input.tankId),
      db.batches.toArray(),
      db.reservations.toArray()
    ])
    if (tank) {
      const verdict = evaluateSubmission(tank, batches, reservations, input.forecastVolumeL, input.submittedAt, input.id)
      shortfallL = verdict.shortfallL
      reason = verdict.fits
        ? `提交写入失败（${message}），当前容量可承诺，可重试占罐`
        : `提交写入失败（${message}）；${verdict.reason}`
    }
  } catch {
    // 读不到最新容量时用默认提示，重试时会重新判定
  }
  await db.transaction('rw', [db.reservations, db.pendingWrites], async () => {
    const now = Date.now()
    const existingDraft = await db.reservations.get(input.id)
    if (!existingDraft || existingDraft.status !== '已入罐') {
      await db.reservations.put(buildReservationDraft(input, shortfallL, reason, now))
    }
    const pending = await db.pendingWrites.where('reservationId').equals(input.id).first()
    if (pending && pending.kind === '提交预约') {
      await db.pendingWrites.update(pending.id, {
        payload: { ...input } as unknown as Record<string, unknown>,
        lastError: message,
        attempts: pending.attempts + 1,
        updatedAt: now
      } as never)
    } else {
      await db.pendingWrites.put({
        id: createId('pw'),
        kind: '提交预约',
        reservationId: input.id,
        payload: { ...input } as unknown as Record<string, unknown>,
        lastError: message,
        attempts: 1,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
    }
  })
}

/**
 * 电话预约抢罐（原子事务）：
 * 先提交的占住（已承诺 / 清洗中排队中），容量不足的留草稿并记录差多少升。
 * 放得下时先入「待复核」再统一走 settleQueues，保证抢罐结果与全量重算同一套算法。
 * 失败时补偿留草稿 + pendingWrites，并把错误继续抛给页面提示。
 */
export async function submitReservation(input: ReservationInput): Promise<ReservationRow> {
  if (!input.parcelId) throw new Error('请选择地块')
  if (!input.tankId) throw new Error('请选择发酵罐')
  if (!(input.forecastVolumeL > 0)) throw new Error('预报采收量必须大于 0')
  try {
    return await db.transaction('rw', [db.reservations, db.batches, db.tanks, db.meta, db.pendingWrites], async () => {
      if (await faultEnabled(META_FAULT_COMMIT)) {
        throw new Error('模拟提交写入失败（故障注入开启）')
      }
      const tank = await db.tanks.get(input.tankId)
      if (!tank) throw new Error('发酵罐不存在')
      const [batches, reservations] = await Promise.all([db.batches.toArray(), db.reservations.toArray()])
      // 预判排除自身（编辑/重新提交已有单时不能把自己的预留重复计入）
      const verdict = evaluateSubmission(
        tank,
        batches,
        reservations,
        input.forecastVolumeL,
        input.submittedAt,
        input.id
      )
      const now = Date.now()
      const existing = await db.reservations.get(input.id)
      const base: ReservationRow = {
        ...input,
        status: verdict.status,
        committedAt: null,
        seq: 0,
        shortfallL: verdict.shortfallL,
        reason: verdict.reason,
        actualVolumeL: existing?.actualVolumeL ?? null,
        arrivedAt: existing?.arrivedAt ?? null,
        actualBrix: existing?.actualBrix ?? null,
        batchId: existing?.batchId ?? null,
        commitmentVersion: existing?.commitmentVersion ?? 0,
        revision: existing?.revision ?? ROW_REVISION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }

      let row: ReservationRow
      if (verdict.fits) {
        // 先进排队参与者（待复核），再由统一算法给出 已承诺/排队中/待复核 与序号
        await db.reservations.put({ ...base, status: '待复核', reason: '提交后等待容量承诺' })
        await settleQueues()
        row = (await db.reservations.get(input.id)) ?? base
        if (row.status === '已承诺' && row.committedAt === null) {
          await db.reservations.update(row.id, { committedAt: now, updatedAt: now } as never)
          row = (await db.reservations.get(input.id)) ?? row
        }
      } else {
        // 抢不到：留草稿，显示差多少升；草稿不参与排队，承诺版本沿用现值
        row = { ...base, status: '草稿' }
        await db.reservations.put(row)
      }

      // 提交成功后清掉同一单的提交补偿（可能由失败重试而来）
      const pending = await db.pendingWrites.where('reservationId').equals(input.id).first()
      if (pending && pending.kind === '提交预约') await db.pendingWrites.delete(pending.id)
      return row
    })
  } catch (error) {
    await persistSubmitFailure(input, error)
    throw error
  }
}

export interface ArrivalInput {
  reservationId: string
  /** 实际到厂量（L），可能与预报不同甚至超量 */
  actualVolumeL: number
  /** 实际到厂日期 YYYY-MM-DD */
  arrivedAt: string
  actualBrix: number
  /** 容量不足时是否强制入罐（强制后触发全量重算，排不下的单退回复核） */
  force: boolean
}

export type ArrivalResult =
  | { outcome: 'arrived'; reservationId: string; batchId: string }
  | { outcome: 'overflow'; reservationId: string; /** 负差量（L），超了多少升 */ shortfallL: number; reason: string }

async function persistArrivalFailure(input: ArrivalInput, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : '到厂登记写入失败'
  await db.transaction('rw', db.pendingWrites, async () => {
    const now = Date.now()
    const existing = await db.pendingWrites
      .where('reservationId')
      .equals(input.reservationId)
      .filter((row) => row.kind === '到厂登记')
      .first()
    if (existing) {
      await db.pendingWrites.update(existing.id, {
        payload: { ...input } as unknown as Record<string, unknown>,
        lastError: message,
        attempts: existing.attempts + 1,
        updatedAt: now
      } as never)
    } else {
      await db.pendingWrites.put({
        id: createId('pw'),
        kind: '到厂登记',
        reservationId: input.reservationId,
        payload: { ...input } as unknown as Record<string, unknown>,
        lastError: message,
        attempts: 1,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
    }
  })
}

/** 到厂登记：按实际量核验容量；超量可强入，强入后全量重算把排不下的单退回复核 */
export async function registerArrival(input: ArrivalInput): Promise<ArrivalResult> {
  if (!(input.actualVolumeL > 0)) throw new Error('实际到厂量必须大于 0')
  try {
    return await db.transaction('rw', [db.reservations, db.batches, db.tanks, db.meta, db.pendingWrites], async () => {
      if (await faultEnabled(META_FAULT_ARRIVE)) {
        throw new Error('模拟到厂登记写入失败（故障注入开启）')
      }
      const reservation = await db.reservations.get(input.reservationId)
      if (!reservation) throw new Error('预约单不存在')
      if (reservation.status === '已入罐') {
        // 幂等：失败重试时可能已入罐，直接清补偿返回
        const pending = await db.pendingWrites
          .where('reservationId')
          .equals(input.reservationId)
          .filter((row) => row.kind === '到厂登记')
          .first()
        if (pending) await db.pendingWrites.delete(pending.id)
        return { outcome: 'arrived', reservationId: input.reservationId, batchId: reservation.batchId ?? '' }
      }
      if (reservation.status === '排队中') throw new Error('罐位仍在清洗中，洗罐完成后才能登记到厂')
      if (reservation.status === '草稿' || reservation.status === '已取消') {
        throw new Error(`预约当前为「${reservation.status}」，无法登记到厂`)
      }
      const tank = await db.tanks.get(reservation.tankId)
      if (!tank) throw new Error('预约的发酵罐已删除')
      if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不能入罐`)

      const [batches, reservations] = await Promise.all([db.batches.toArray(), db.reservations.toArray()])
      const activeOnTank = batches.filter((b) => b.tankId === tank.id && b.state !== '已出罐')
      if (activeOnTank.length > 0) {
        throw new Error(`罐 ${tank.code} 仍有在罐批次，请先出罐再接车`)
      }
      const otherHolds = reservations
        .filter(
          (r) =>
            r.id !== reservation.id &&
            r.tankId === tank.id &&
            (r.status === '已承诺' || r.status === '排队中')
        )
        .reduce((sum, r) => sum + r.forecastVolumeL, 0)
      const leftAfter = tank.capacityL - otherHolds - input.actualVolumeL
      if (leftAfter < 0 && !input.force) {
        return {
          outcome: 'overflow',
          reservationId: input.reservationId,
          shortfallL: leftAfter,
          reason: `实际到厂 ${input.actualVolumeL}L，占住其它预留后罐内还差 ${-leftAfter}L`
        }
      }

      const now = Date.now()
      const batchId = createId('batch')
      await db.batches.put({
        id: batchId,
        parcelId: reservation.parcelId,
        tankId: tank.id,
        harvestDate: input.arrivedAt,
        volumeL: input.actualVolumeL,
        brix: input.actualBrix,
        state: '酒精发酵',
        lastOperationAt: null,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
      await db.tanks.update(tank.id, { state: '在用', updatedAt: now } as never)
      await db.reservations.update(reservation.id, {
        status: '已入罐',
        actualVolumeL: input.actualVolumeL,
        arrivedAt: input.arrivedAt,
        actualBrix: input.actualBrix,
        batchId,
        seq: 0,
        shortfallL: leftAfter,
        reason: leftAfter < 0 ? `实际超量 ${-leftAfter}L 强入，已触发排队重算` : '到厂入罐完成',
        updatedAt: now
      } as never)
      // 本单离开占容量队列且实际量落罐：全量重算，排不下的单退「待复核」
      const version = await settleQueues()
      // 已入罐单也记下经历过的承诺版本
      await db.reservations.update(reservation.id, { commitmentVersion: version } as never)
      const pending = await db.pendingWrites
        .where('reservationId')
        .equals(reservation.id)
        .filter((row) => row.kind === '到厂登记')
        .first()
      if (pending) await db.pendingWrites.delete(pending.id)
      return { outcome: 'arrived', reservationId: reservation.id, batchId }
    })
  } catch (error) {
    await persistArrivalFailure(input, error)
    throw error
  }
}

/** 取消预约：释放预留并重算，后续待复核单可能补回 */
export async function cancelReservation(id: string): Promise<void> {
  await db.transaction('rw', QUEUE_TABLES, async () => {
    const reservation = await db.reservations.get(id)
    if (!reservation) throw new Error('预约单不存在')
    if (reservation.status === '已入罐') throw new Error('已入罐的预约不能取消，请到入罐页办理出罐')
    if (reservation.status === '已取消') return
    const now = Date.now()
    await db.reservations.update(id, {
      status: '已取消',
      seq: 0,
      reason: '电话取消预约，预留容量已释放',
      updatedAt: now
    } as never)
    await settleQueues()
  })
  // 取消成功后清理同单的提交/取消补偿
  const pending = await db.pendingWrites.where('reservationId').equals(id).toArray()
  await Promise.all(pending.filter((p) => p.kind !== '到厂登记').map((p) => db.pendingWrites.delete(p.id)))
}

/** 改约（编辑草稿 / 重新指定罐与量）：直接覆盖后以提交动作重新抢罐 */
export async function updateReservationDraft(
  id: string,
  patch: Partial<Pick<Reservation, 'parcelId' | 'tankId' | 'expectedAt' | 'forecastVolumeL' | 'contact' | 'note'>>
): Promise<void> {
  await db.reservations.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeReservation(id: string): Promise<void> {
  await db.transaction('rw', [db.reservations, db.pendingWrites, ...QUEUE_TABLES], async () => {
    await db.pendingWrites.where('reservationId').equals(id).delete()
    await db.reservations.delete(id)
    await settleQueues()
  })
}

/**
 * 容量/罐位变动后的统一入口（罐转清洗、改容量、批次直建/改绑等）：
 * 全量重算排队，排不下的入罐单退「待复核」。返回新的承诺版本号。
 */
export async function recomputeReservationQueues(): Promise<number> {
  return db.transaction('rw', QUEUE_TABLES, async () => settleQueues())
}

/* --------------------------- 失败写入重试 --------------------------- */

/** 回放一条失败写入；成功自动删除补偿记录，失败则继续保留并累加尝试次数 */
export async function retryPendingWrite(pendingId: string): Promise<void> {
  const pending = await db.pendingWrites.get(pendingId)
  if (!pending) return
  if (pending.kind === '提交预约') {
    const input = pending.payload as unknown as ReservationInput
    await submitReservation(input)
    return
  }
  if (pending.kind === '到厂登记') {
    const input = pending.payload as unknown as ArrivalInput
    const result = await registerArrival(input)
    if (result.outcome === 'overflow') {
      // 补偿载荷未携带强入确认：不删除补偿，提示用户改量或强入后再重试
      throw new Error(`${result.reason}；请到预约页改量或确认强制入罐后再重试`)
    }
    return
  }
  await cancelReservation(pending.reservationId)
}

export async function dismissPendingWrite(pendingId: string): Promise<void> {
  await db.pendingWrites.delete(pendingId)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  commitmentVersion: number
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  readings: Reading[]
  operations: Operation[]
  mlfs: Mlf[]
  tastings: Tasting[]
  reservations: Reservation[]
  pendingWrites: PendingWrite[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, reservations, pendingWrites] =
    await Promise.all([
      db.parcels.toArray(),
      db.tanks.toArray(),
      db.batches.toArray(),
      db.readings.toArray(),
      db.operations.toArray(),
      db.mlfs.toArray(),
      db.tastings.toArray(),
      db.reservations.toArray(),
      db.pendingWrites.toArray()
    ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    commitmentVersion: await getCommitmentVersion(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow),
    reservations: reservations.map(stripRow),
    pendingWrites: pendingWrites.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

/** 兼容旧版备份：补齐预约字段后统一重新排队 */
function normalizeReservation(row: Partial<Reservation>): Reservation {
  return {
    id: String(row.id ?? createId('rsv')),
    parcelId: String(row.parcelId ?? ''),
    tankId: String(row.tankId ?? ''),
    expectedAt: String(row.expectedAt ?? ''),
    forecastVolumeL: Number(row.forecastVolumeL ?? 0),
    contact: String(row.contact ?? ''),
    note: String(row.note ?? ''),
    status: (row.status as Reservation['status']) ?? '草稿',
    submittedAt: Number(row.submittedAt ?? Date.now()),
    committedAt: typeof row.committedAt === 'number' ? row.committedAt : null,
    seq: Number(row.seq ?? 0),
    shortfallL: Number(row.shortfallL ?? 0),
    reason: String(row.reason ?? '旧备份导入，等待重新排队'),
    actualVolumeL: typeof row.actualVolumeL === 'number' ? row.actualVolumeL : null,
    arrivedAt: typeof row.arrivedAt === 'string' ? row.arrivedAt : null,
    actualBrix: typeof row.actualBrix === 'number' ? row.actualBrix : null,
    batchId: typeof row.batchId === 'string' ? row.batchId : null,
    commitmentVersion: 0
  }
}

function normalizePendingWrite(row: Partial<PendingWrite>): PendingWrite {
  return {
    id: String(row.id ?? createId('pw')),
    kind: (row.kind as PendingWriteKind) ?? '提交预约',
    reservationId: String(row.reservationId ?? ''),
    payload: (row.payload as Record<string, unknown>) ?? {},
    lastError: String(row.lastError ?? ''),
    attempts: Number(row.attempts ?? 0)
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.tanks,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.reservations,
      db.pendingWrites,
      db.meta
    ],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.reservations.clear(),
        db.pendingWrites.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
      // 旧数据：补承诺版本号（0）再排队
      await db.reservations.bulkPut((snapshot.reservations ?? []).map(normalizeReservation).map(stamp))
      await db.pendingWrites.bulkPut((snapshot.pendingWrites ?? []).map(normalizePendingWrite).map(stamp))
      // 先放历史版本号基线，重算有变更时 settle 会自动 +1
      const now = Date.now()
      await db.meta.put({
        key: META_COMMITMENT_VERSION,
        value: Number(snapshot.commitmentVersion ?? 0),
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
      await settleQueues()
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.tanks,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.reservations,
      db.pendingWrites,
      db.meta
    ],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.reservations.clear(),
        db.pendingWrites.clear(),
        db.meta.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, reservations, pendingWrites, commitmentVersion] =
    await Promise.all([
      db.parcels.count(),
      db.tanks.count(),
      db.batches.count(),
      db.readings.count(),
      db.operations.count(),
      db.mlfs.count(),
      db.tastings.count(),
      db.reservations.count(),
      db.pendingWrites.count(),
      getCommitmentVersion()
    ])
  return {
    parcels,
    tanks,
    batches,
    readings,
    operations,
    mlfs,
    tastings,
    reservations,
    pendingWrites,
    commitmentVersion
  }
}
