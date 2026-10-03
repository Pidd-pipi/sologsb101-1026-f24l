/**
 * 作业 store：维护作业顺序、完成态与作业类型筛选。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Operation } from '@/types/operation'
import type { FilterModel } from '@/types/filter'
import {
  completeOperation,
  nextOperationSeq,
  putOperation,
  removeOperation,
  reorderOperations,
  updateOperation as updateOperationRow,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const OPERATION_FILTER_KEYS = ['types', 'states']

export const useOperationStore = defineStore('operation', () => {
  const filters = ref<FilterModel>({ keyword: '', types: [], states: [] })
  const currentBatchId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', types: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, OPERATION_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  async function createOperation(payload: Omit<Operation, 'id' | 'seq'>): Promise<string> {
    if (!payload.batchId) throw new Error('请选择批次')
    if (!payload.operator.trim()) throw new Error('请填写操作人')
    const seq = await nextOperationSeq(payload.batchId)
    const now = Date.now()
    const id = createId('operation')
    await putOperation({ ...payload, id, seq, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    return id
  }

  async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
    await updateOperationRow(id, patch)
  }

  async function deleteOperation(id: string): Promise<void> {
    await removeOperation(id)
  }

  /** 标记完成：回写批次最近作业时间 */
  async function finish(id: string): Promise<void> {
    await completeOperation(id)
  }

  /** 拖拽调序后按新顺序批量写回 seq */
  async function move(list: Operation[], from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await reorderOperations(next.map((item) => item.id))
  }

  return {
    filters,
    currentBatchId,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createOperation,
    updateOperation,
    deleteOperation,
    finish,
    move
  }
})
