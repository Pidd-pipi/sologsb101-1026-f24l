/**
 * 发酵罐 store：维护罐位占用、容量筛选条件与占用冲突校验。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Tank, TankState } from '@/types/tank'
import type { FilterModel } from '@/types/filter'
import type { BatchRow, TankRow } from '@/utils/db'
import {
  assertTankAssignable,
  putTank,
  removeTank,
  updateTank as updateTankRow,
  recalcTankQueue,
  ROW_REVISION,
  COMMITMENT_VERSION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const TANK_FILTER_KEYS = ['materials', 'tempControls', 'states']

export const useTankStore = defineStore('tank', () => {
  const filters = ref<FilterModel>({ keyword: '', materials: [], tempControls: [], states: [] })
  const selectedId = ref<string | null>(null)
  const busy = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', materials: [], tempControls: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, TANK_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedId.value = id
  }

  /** 找出占用该罐的在罐批次（无则返回 null） */
  function occupancyOf(tankId: string, batches: BatchRow[]): BatchRow | null {
    return batches.find((batch) => batch.tankId === tankId && batch.state !== '已出罐') ?? null
  }

  /** 分配前校验：罐位空闲且未被其它在罐批次占用 */
  async function ensureAssignable(tankId: string, batchId: string | null): Promise<void> {
    busy.value = true
    try {
      await assertTankAssignable(tankId, batchId)
    } finally {
      busy.value = false
    }
  }

  async function createTank(payload: Omit<Tank, 'id'>): Promise<string> {
    const now = Date.now()
    const id = createId('tank')
    await putTank({
      ...payload,
      id,
      commitmentVersion: COMMITMENT_VERSION,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    selectedId.value = id
    return id
  }

  async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
    await updateTankRow(id, patch)
  }

  async function deleteTank(id: string): Promise<void> {
    await removeTank(id)
    if (selectedId.value === id) selectedId.value = null
  }

  /** 罐位状态流转（空闲 ⇄ 清洗中）；置为「在用」需由批次绑定触发。转清洗后重算该罐排队，排不下的预约退回复核 */
  async function changeState(tank: TankRow, next: TankState): Promise<void> {
    if (next === '在用') {
      throw new Error('罐位「在用」由入罐批次绑定后自动置位，请到入罐登记页分配批次')
    }
    await updateTankRow(tank.id, { state: next })
    if (next === '清洗中') {
      // 罐位不可用：其下预约中全部退回复核
      await recalcTankQueue(tank.id)
    } else if (next === '空闲') {
      // 清洗完成：腾出容量，恢复排得下的待复核预约
      await recalcTankQueue(tank.id)
    }
  }

  return {
    filters,
    selectedId,
    busy,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    occupancyOf,
    ensureAssignable,
    createTank,
    updateTank,
    deleteTank,
    changeState
  }
})
