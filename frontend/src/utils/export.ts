/**
 * 批次档案 JSON 序列化与校验
 * 品评页用于导出单批次完整档案，也是「导入导出备份」的数据校验入口。
 */
import type { Batch } from '../types/batch'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import { db, DB_NAME, DB_SCHEMA_VERSION, listOperations, listReadings, listTastings } from './db'
import { abvFromSg, gravityDeclinePerDay, isOverTemp, potentialAbv } from './gravity'
import { nowIso } from './uuid'

/** 单批次档案：导出给车间与酒窖存档用 */
export interface BatchArchive {
  name: string
  schemaVersion: number
  exportedAt: string
  batch: Batch
  parcel: Parcel | null
  tank: Tank | null
  readings: Reading[]
  operations: Operation[]
  mlf: Mlf | null
  tastings: Tasting[]
  summary: {
    /** 读数覆盖天数 */
    days: number
    /** 平均比重日下降速率 */
    avgDeclinePerDay: number
    /** 最新比重 */
    latestGravity: number
    /** 潜在酒精度（%vol） */
    potentialAbv: number
    /** 由首末读数估算的实际酒精度 */
    estimatedAbv: number
    /** 超温天数 */
    overTempDays: number
    /** 最优品评结论 */
    bestVerdict: string
  }
}

/** 汇总某个批次的档案（不抛错，缺父记录时对应字段为 null） */
export async function buildBatchArchive(batchId: string): Promise<BatchArchive> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在，无法导出档案')
  const [parcel, tank, allReadings, allOperations, mlf, allTastings] = await Promise.all([
    batch.parcelId ? db.parcels.get(batch.parcelId) : Promise.resolve(undefined),
    batch.tankId ? db.tanks.get(batch.tankId) : Promise.resolve(undefined),
    listReadings(),
    listOperations(),
    db.mlfs.where('batchId').equals(batchId).first(),
    listTastings()
  ])
  const readings = allReadings.filter((row) => row.batchId === batchId)
  const operations = allOperations.filter((row) => row.batchId === batchId)
  const tastings = allTastings.filter((row) => row.batchId === batchId)

  let declineSum = 0
  for (let i = 1; i < readings.length; i += 1) {
    const days =
      (new Date(readings[i].date).getTime() - new Date(readings[i - 1].date).getTime()) / 86400000
    declineSum += gravityDeclinePerDay(readings[i - 1].gravity, readings[i].gravity, days)
  }
  const first = readings[0]
  const last = readings[readings.length - 1]
  const bestVerdict =
    tastings.find((item) => item.verdict === '可直接装瓶')?.verdict ??
    tastings.find((item) => item.verdict === '需调配')?.verdict ??
    tastings[0]?.verdict ??
    '未品评'

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    batch: stripRevision(batch),
    parcel: parcel ? stripRevision(parcel) : null,
    tank: tank ? stripRevision(tank) : null,
    readings: readings.map(stripRevision),
    operations: operations.map(stripRevision),
    mlf: mlf ? stripRevision(mlf) : null,
    tastings: tastings.map(stripRevision),
    summary: {
      days: readings.length,
      avgDeclinePerDay: readings.length > 1 ? Number((declineSum / (readings.length - 1)).toFixed(4)) : 0,
      latestGravity: last ? last.gravity : 0,
      potentialAbv: first ? potentialAbv(first.gravity) : 0,
      estimatedAbv: first && last ? abvFromSg(first.gravity, last.gravity) : 0,
      overTempDays: readings.filter((row) => isOverTemp(row.tempC)).length,
      bestVerdict
    }
  }
}

type WithRevision = { revision?: number; createdAt?: number; updatedAt?: number }

function stripRevision<T extends WithRevision>(row: T): T {
  const copy: Record<string, unknown> = { ...row }
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as T
}

/** 序列化为带缩进的 JSON 文本 */
export function serializeArchive(archive: BatchArchive): string {
  return JSON.stringify(archive, null, 2)
}

/** 校验并解析批次档案 JSON 文本，失败时抛出可读错误 */
export function parseArchive(text: string): BatchArchive {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('档案根节点必须是对象')
  }
  const candidate = parsed as Partial<BatchArchive>
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段')
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段')
  if (!candidate.batch || typeof candidate.batch.id !== 'string') throw new Error('缺少 batch.id 字段')
  if (!Array.isArray(candidate.readings)) throw new Error('readings 必须是数组')
  return candidate as BatchArchive
}

/** 触发浏览器下载（纯前端，无需后端） */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
