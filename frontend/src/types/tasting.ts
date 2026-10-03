/** 品评结论 */
export type TastingVerdict = '待定' | '可直接装瓶' | '需调配'

/** 品评与调配记录：同批次可多次并列对比 */
export interface Tasting {
  id: string
  /** 所属批次 */
  batchId: string
  /** 品评日期 */
  date: string
  /** 香气描述 */
  aroma: string
  /** 单宁描述 */
  tannin: string
  /** 酸度描述 */
  acidity: string
  /** 结论 */
  verdict: TastingVerdict
}

export const TASTING_VERDICTS: TastingVerdict[] = ['待定', '可直接装瓶', '需调配']

export function createEmptyTasting(): Omit<Tasting, 'id'> {
  return {
    batchId: '',
    date: new Date().toISOString().slice(0, 10),
    aroma: '',
    tannin: '',
    acidity: '',
    verdict: '待定'
  }
}
