/** 地块朝向 */
export type ParcelAspect = '南' | '东南' | '东' | '西' | '北'

/** 葡萄地块：一次采收的源头单位，入罐批次都挂在地块下 */
export interface Parcel {
  id: string
  /** 地块名称 */
  name: string
  /** 品种 */
  variety: string
  /** 面积（亩） */
  areaMu: number
  /** 树龄（年） */
  vineAge: number
  /** 朝向 */
  aspect: ParcelAspect
}

/** 地块卡片回显的派生统计 */
export interface ParcelStats {
  parcelId: string
  /** 在罐批次数（未出罐） */
  activeBatchCount: number
  /** 累计入罐量（L） */
  totalVolumeL: number
}

export const PARCEL_ASPECTS: ParcelAspect[] = ['南', '东南', '东', '西', '北']

export const PARCEL_VARIETIES: string[] = [
  '赤霞珠',
  '梅洛',
  '品丽珠',
  '西拉',
  '霞多丽',
  '雷司令',
  '长相思'
]

/** 新建地块表单的默认值 */
export function createEmptyParcel(): Omit<Parcel, 'id'> {
  return { name: '', variety: PARCEL_VARIETIES[0], areaMu: 1, vineAge: 5, aspect: '南' }
}
