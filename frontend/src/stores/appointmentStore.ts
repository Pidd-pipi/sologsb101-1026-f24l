/**
 * 到厂预约 store：维护容量承诺、草稿与排队重算。
 * 多个标签同时提交同一罐时，先提交的占住；容量不足的一页保留草稿并显示差多少升。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { FilterModel } from '@/types/filter'
import {
  db,
  bookAppointment,
  updateAppointment,
  convertAppointmentToBatch,
  recalcTankQueue,
  type BookAppointmentResult
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

const DRAFT_KEY = 'gbwinetank:appointment-draft'

export interface AppointmentDraft {
  parcelId: string
  tankId: string
  harvestDate: string
  volumeL: number
  note: string
  /** 差多少升（容量不足时 >0） */
  shortageL: number
  /** 提交时罐剩余可约量 */
  remainingL: number
  reason: string
  failedAt: number
}

export const APPOINTMENT_FILTER_KEYS = ['states', 'parcelIds']

function loadDraft(): AppointmentDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    return JSON.parse(raw) as AppointmentDraft
  } catch {
    return null
  }
}

function saveDraft(draft: AppointmentDraft): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
}

function clearDraftStorage(): void {
  localStorage.removeItem(DRAFT_KEY)
}

export const useAppointmentStore = defineStore('appointment', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], parcelIds: [] })
  /** 容量不足 / 写入失败时保留的草稿 */
  const draft = ref<AppointmentDraft | null>(loadDraft())
  const busy = ref(false)
  const lastResult = ref<BookAppointmentResult | null>(null)

  const hasDraft = computed(() => draft.value !== null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [], parcelIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, APPOINTMENT_FILTER_KEYS)
  }

  /**
   * 提交预约：在事务内重算剩余容量，先提交的占住。
   * 容量不足 → 保留草稿并记下差多少升；写入失败 → 同样保留草稿可重试。
   */
  async function book(input: {
    parcelId: string
    tankId: string
    harvestDate: string
    volumeL: number
    note: string
  }): Promise<BookAppointmentResult> {
    busy.value = true
    try {
      const result = await bookAppointment(input)
      lastResult.value = result
      if (result.ok) {
        clearDraftStorage()
        draft.value = null
      } else {
        const d: AppointmentDraft = {
          ...input,
          shortageL: result.shortageL,
          remainingL: result.remainingL,
          reason: result.reason,
          failedAt: Date.now()
        }
        saveDraft(d)
        draft.value = d
      }
      return result
    } catch (error) {
      // 写入失败：保留预约草稿，可重试
      const d: AppointmentDraft = {
        ...input,
        shortageL: 0,
        remainingL: 0,
        reason: error instanceof Error ? error.message : '写入失败',
        failedAt: Date.now()
      }
      saveDraft(d)
      draft.value = d
      throw error
    } finally {
      busy.value = false
    }
  }

  /** 重试草稿：重新提交，成功则清草稿 */
  async function retryDraft(): Promise<BookAppointmentResult> {
    if (!draft.value) throw new Error('暂无草稿')
    const d = draft.value
    return await book({
      parcelId: d.parcelId,
      tankId: d.tankId,
      harvestDate: d.harvestDate,
      volumeL: d.volumeL,
      note: d.note
    })
  }

  function discardDraft(): void {
    clearDraftStorage()
    draft.value = null
  }

  async function cancel(id: string): Promise<void> {
    const apt = await db.appointments.get(id)
    await updateAppointment(id, { state: '已取消' })
    // 取消释放容量：重算排队，排得下的待复核预约恢复为预约中
    if (apt) await recalcTankQueue(apt.tankId)
  }

  /** 预约入罐：转为真实批次；实际入罐超量会重算排队 */
  async function convert(
    id: string,
    payload: { harvestDate: string; volumeL: number; brix: number }
  ): Promise<{ batchId: string; overCapacity: boolean }> {
    return await convertAppointmentToBatch(id, payload)
  }

  /** 重算某罐排队（容量不足的退回复核，排得下的保留/恢复） */
  async function recalc(tankId: string): Promise<void> {
    await recalcTankQueue(tankId)
  }

  return {
    filters,
    draft,
    busy,
    lastResult,
    hasDraft,
    setFilters,
    resetFilters,
    applyQuery,
    book,
    retryDraft,
    discardDraft,
    cancel,
    convert,
    recalc
  }
})
