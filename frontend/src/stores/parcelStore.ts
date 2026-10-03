/**
 * 地块 store：维护地块列表的筛选条件与当前选中地块，
 * 并把新增 / 编辑 / 删除动作统一收口到 Dexie 持久化层。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Parcel } from '@/types/parcel'
import type { FilterModel } from '@/types/filter'
import { putParcel, removeParcel, updateParcel as updateParcelRow, ROW_REVISION } from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

/** 地块页参与 URL 同步的筛选键 */
export const PARCEL_FILTER_KEYS = ['varieties', 'aspects']

export const useParcelStore = defineStore('parcel', () => {
  /** 列表筛选条件（跨页保留，并同步到 URL query） */
  const filters = ref<FilterModel>({ keyword: '', varieties: [], aspects: [] })
  /** 当前选中的地块 id */
  const selectedId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', varieties: [], aspects: [] }
  }

  /** 从 URL query 还原筛选条件 */
  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, PARCEL_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedId.value = id
  }

  async function createParcel(payload: Omit<Parcel, 'id'>): Promise<string> {
    const now = Date.now()
    const id = createId('parcel')
    await putParcel({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    selectedId.value = id
    return id
  }

  async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
    await updateParcelRow(id, patch)
  }

  /** 删除地块（级联删除其下批次与批次子表，并释放罐位） */
  async function deleteParcel(id: string): Promise<void> {
    await removeParcel(id)
    if (selectedId.value === id) selectedId.value = null
  }

  return { filters, selectedId, setFilters, resetFilters, applyQuery, select, createParcel, updateParcel, deleteParcel }
})
