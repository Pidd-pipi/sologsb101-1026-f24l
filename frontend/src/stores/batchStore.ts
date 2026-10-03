/**
 * 入罐批次 store：维护在罐批次、当前选中批次与地块/罐绑定校验。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { FilterModel } from '@/types/filter'
import type { BatchRow } from '@/utils/db'
import {
  assertTankAssignable,
  putBatch,
  removeBatch,
  shipBatch as shipBatchRow,
  updateBatch as updateBatchRow,
  updateTank,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const BATCH_FILTER_KEYS = ['states', 'parcelIds']

export const useBatchStore = defineStore('batch', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], parcelIds: [] })
  /** 当前选中的批次 id（读数页、作业页共用上下文） */
  const currentBatchId = ref<string | null>(null)
  const error = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [], parcelIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, BATCH_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /** 入罐登记：先校验罐位可分配，再把罐置为「在用」 */
  async function createBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    if (!payload.parcelId) throw new Error('请选择地块')
    if (!payload.tankId) throw new Error('请选择发酵罐')
    await assertTankAssignable(payload.tankId, null)
    const now = Date.now()
    const id = createId('batch')
    await putBatch({ ...payload, id, lastOperationAt: null, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    await updateTank(payload.tankId, { state: '在用' })
    currentBatchId.value = id
    return id
  }

  /** 改绑罐位：校验新罐可用后再释放旧罐 */
  async function updateBatch(id: string, patch: Partial<Batch>, current: BatchRow): Promise<void> {
    error.value = null
    if (patch.tankId && patch.tankId !== current.tankId) {
      await assertTankAssignable(patch.tankId, id)
      await updateTank(patch.tankId, { state: '在用' })
      if (current.tankId) await updateTank(current.tankId, { state: '空闲' })
    }
    await updateBatchRow(id, patch)
  }

  async function deleteBatch(id: string): Promise<void> {
    await removeBatch(id)
    if (currentBatchId.value === id) currentBatchId.value = null
  }

  /** 出罐：释放罐位并归档批次 */
  async function ship(id: string): Promise<void> {
    await shipBatchRow(id)
  }

  return {
    filters,
    currentBatchId,
    error,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createBatch,
    updateBatch,
    deleteBatch,
    ship
  }
})
