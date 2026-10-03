# 葡萄酒发酵罐与倒罐批次台（gbwinetank）

面向酒庄酿酒师与发酵车间班组的本地化车间台账：按地块采收把葡萄入罐发酵，逐日记录比重、温度与糖度，编排倒罐、压帽与淋皮作业，跟踪苹果酸乳酸发酵进度，并在出罐前完成品评与调配结论。

核心动作：**建地块与品种 → 配置发酵罐容量 → 录发酵读数 → 排作业工序 → 启动苹乳发酵 → 录品评并导出批次档案**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22826**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbwinetank}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库 JSON / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、进度条、时间线交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22826 |
| 状态管理 | Pinia（setup store） | `parcelStore` / `tankStore` / `batchStore` / `operationStore` / `mlfStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbwinetank-db`，含结构版本号与 upgrade 迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22826
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22826）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/parcels` | 地块与品种台账 | Parcel、Batch | 新建/编辑/删除地块、按品种与朝向筛选、回显在罐批次数与累计入罐量、筛选同步 URL query |
| `/appointments` | 到厂预约与容量承诺 | Appointment、Tank、Batch、Parcel | 采收量先占发酵罐、总预留不超剩余容量、先提交的占住、容量不足留草稿显示差多少升、排队重算退回复核、预约入罐 |
| `/tanks` | 发酵罐容量配置与罐位看板 | Tank、Batch | 按材质/温控/罐位筛选、罐位占用冲突校验、清洗状态流转、转清洗触发预约排队重算 |
| `/batches` | 入罐登记与发酵读数 | Batch、Reading、Parcel、Tank | 绑定地块与罐入罐、容量承诺校验、逐日录比重/温度/糖度、趋势条、超温标记、出罐释放罐位并重算排队 |
| `/operations` | 倒罐与压帽作业编排 | Operation、Batch | 按日期排班、拖拽调序（含上下移按钮）、指派操作人、完成回写批次最近作业时间 |
| `/mlf` | 苹果酸乳酸发酵跟踪 | Mlf、Batch、Reading | 启动苹乳、逐次录入苹果酸、低于阈值自动判定结束并联动批次状态 |
| `/tasting` | 品评调配与批次档案 | Tasting 及全部模型 | 同批次多次品评并列对比、批次档案 JSON 导出、本地库版本查看与整库导入导出 |

---

## 五、目录结构

```
gbwinetank/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # parcel tank batch reading operation mlf tasting appointment filter
        ├── stores/             # parcelStore tankStore batchStore operationStore mlfStore appointmentStore
        ├── components/common/  # StageTag FilterBar StatBadge EmptyPanel
        ├── hooks/              # useFermentTrend useIdbTable
        ├── utils/              # gravity db export seed uuid query appointment
        ├── pages/              # ParcelList AppointmentBoard TankBoard BatchReading OperationPlan MlfBoard TastingExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbwinetank-db`（Dexie 封装），结构版本号 `version(2)`，并带 `upgrade()` 迁移逻辑（v1 为历史行补齐行修订号与时间戳；v2 新增到厂预约表并为历史地块/罐/批次补 `commitmentVersion` 承诺版本号，打开库后幂等重算排队）。
- **分表存储**：`parcels` 地块、`tanks` 发酵罐、`batches` 入罐批次、`readings` 发酵读数、`operations` 作业、`mlfs` 苹乳发酵、`tastings` 品评调配、`appointments` 到厂预约，共 8 张表；每行带 `revision` / `createdAt` / `updatedAt`。
- **容量承诺**：到厂预约在 read-write 事务内重算罐剩余容量（实际在罐 + 已预留 ≤ 容量），先提交的占住；容量不足的一页保留草稿并显示差多少升，可重试。实际入罐超量、罐位转清洗或取消后重算排队，排不下的预约退回复核。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `parcels` 表为空时调用 `seedDatabase()`，灌入互相引用的演示数据（地块 → 发酵罐 → 批次 → 读数/作业/苹乳/品评 → 预约），保证每个页面首次打开都有内容；播种幂等，清空后重进会重新播种。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **数据迁移**：在「品评与批次档案」页可导出整库 JSON 备份，或导出单批次档案；在其它设备用「导入备份」还原。
- **级联规则**：删除地块会级联删除其下批次、预约与批次的读数/作业/苹乳/品评并释放罐位；在罐批次不允许删除发酵罐。
