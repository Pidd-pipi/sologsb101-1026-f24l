/**
 * 苹乳发酵 store：维护苹乳进度、苹果酸下降判定与批次状态联动。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Mlf } from '@/types/mlf'
import { MALIC_DONE_THRESHOLD, MALIC_START_G } from '@/types/mlf'
import type { FilterModel } from '@/types/filter'
import type { MlfRow } from '@/utils/db'
import { putMlf, removeMlf, updateBatch, updateMlf as updateMlfRow, ROW_REVISION } from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import { today } from '@/utils/uuid'

export const MLF_FILTER_KEYS = ['states']

export const useMlfStore = defineStore('mlf', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [] })
  const currentBatchId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, MLF_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /** 启动苹乳：新建或复用记录，并联动批次进入苹乳发酵 */
  async function startMlf(batchId: string, existing?: MlfRow): Promise<void> {
    const now = Date.now()
    if (existing) {
      await updateMlfRow(existing.id, { state: '进行中', startDate: existing.startDate || today(), endDate: '' })
    } else {
      await putMlf({
        id: createId('mlf'),
        batchId,
        startDate: today(),
        endDate: '',
        malicG: MALIC_START_G,
        state: '进行中',
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
    }
    await updateBatch(batchId, { state: '苹乳发酵' })
  }

  /**
   * 录入苹果酸值；低于阈值自动判定结束并联动批次状态。
   * 返回是否因达到阈值而结束。
   */
  async function recordMalic(mlf: MlfRow, malicG: number): Promise<boolean> {
    const done = malicG <= MALIC_DONE_THRESHOLD
    await updateMlfRow(mlf.id, {
      malicG,
      state: done ? '已完成' : '进行中',
      endDate: done ? today() : ''
    })
    if (done && mlf.state !== '已完成') {
      await updateBatch(mlf.batchId, { state: '苹乳发酵' })
    }
    return done
  }

  /** 手动结束苹乳 */
  async function finishMlf(mlf: MlfRow): Promise<void> {
    await updateMlfRow(mlf.id, { state: '已完成', endDate: today() })
  }

  async function deleteMlf(mlf: MlfRow): Promise<void> {
    await removeMlf(mlf.id)
    await updateBatch(mlf.batchId, { state: '酒精发酵' })
  }

  /** 苹乳进度百分比（按初始值线性折算） */
  function progressOf(mlf: Mlf): number {
    if (mlf.state === '未启动') return 0
    if (mlf.state === '已完成') return 100
    const ratio = (MALIC_START_G - mlf.malicG) / (MALIC_START_G - MALIC_DONE_THRESHOLD)
    return Math.max(0, Math.min(100, Math.round(ratio * 100)))
  }

  return {
    filters,
    currentBatchId,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    startMlf,
    recordMalic,
    finishMlf,
    deleteMlf,
    progressOf
  }
})
