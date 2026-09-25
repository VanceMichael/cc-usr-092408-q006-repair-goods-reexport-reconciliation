# 跨境贸易事件版本归并

跨境贸易事件服务后端。基线提供 Node.js 健康入口与 SQLite 迁移，现已增加**维修货物复运核销链**：
精密仪器临时出境维修后，可证明每个原序列号按期复运，或依法转入延期、转售、报废、正式进口等处置。

## 维修货物复运核销链

### 业务规则与不变量

- **出境申请固定要素**：原报关单号、设备序列号、附件清单、申报状态、维修期限、允许承修方；
  申请批准后承修方只能是名单内主体，原机与每个附件各自成为独立可核销根部件。
- **谱系只追加**：检测 `detect`、拆解 `disassemble`、替换 `replace`、重新装配 `reassemble`
  按序生成事件，不可改写。
  - 替换必须显式声明与原件的对应：`one_to_one`（一对一、数量相等）或 `combination`（多个原件合并为一个新件）。
  - 拆解为 `split`：拆出子件数量之和必须等于拆解数量。
- **分批复运、数量不重叠**：复运可分任意批次，但核销以只追加的 `disposition_ledger`
  为唯一权威来源；同一原设备已核销与待核销数量重叠时整批确认返回 422，
  任何后到清单都不能覆盖既有核销。
- **差异转人工**：少件、增件、序列号变化、重量偏差（默认 5% 容差）逐行登记人工比对单；
  有差异的行在裁决前不核销，少件只能凭报废/转售/正式进口独立审批了结，增件登记为 `extra` 不占原义务。
- **独立审批**：延期、转售、报废、正式进口各自独立申请与审批；
  延期延续原期限，转售/报废/正式进口按数量核销并停止原期限，全部轨迹写入期限历史。
- **承运回执去重**：离线回执按自身流水号幂等入库，可先到达后绑定批次，已绑定不可改绑。
- **并发互斥**：复运批次建立时锁定方案版本基线；复运确认与维修方案变更生效共用
  `state_version` 乐观并发控制，竞争时后到者 409，同一设备至多一个生效方案版本。
- **到期扫描**：创建扫描时先固化候选快照，再以稳定游标分页生成未核销清单；
  中断后凭 `run_id` 续扫，已标记项不重复、不漏。
- **全链追溯**：从任一返运包装号可追到原报关单、原设备、附件、全部维修动作与谱系链接、
  审批、期限历史、核销流水、承运回执与剩余义务。
- **持久化**：SQLite（WAL）落盘，进程重启重开同一数据库后状态与谱系完整保留。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/applications` | 出境申报（固定原报关单/序列号/附件/期限/承修方） |
| POST | `/api/applications/:id/decision` | 申报审批（approved/rejected） |
| GET | `/api/applications/:id` | 申请详情（含设备、附件、部件） |
| GET | `/api/items/:id` | 设备义务状态（剩余/已核销、流水、审批、期限历史、方案） |
| POST | `/api/items/:id/events` | 追加检测/拆解/替换/重新装配谱系事件 |
| GET | `/api/items/:id/genealogy` | 部件与谱系事件/对应关系 |
| POST | `/api/items/:id/return-batches` | 登记分批返运计划（包装与清单） |
| POST | `/api/return-batches/:id/confirm` | 复运确认（实物比对、核销、差异转人工） |
| GET | `/api/return-batches/:id` | 批次详情（包装、清单、人工比对单） |
| POST | `/api/manual-reviews/:id/resolve` | 人工比对裁决（accepted/rejected） |
| POST | `/api/carrier-receipts` | 离线承运回执入库（按 receipt_no 去重） |
| POST | `/api/carrier-receipts/:receiptNo/link` | 回执绑定批次 |
| POST | `/api/items/:id/dispositions` | 提交延期/转售/报废/正式进口申请 |
| POST | `/api/dispositions/:id/decision` | 处置审批决定 |
| POST | `/api/items/:id/plans` | 提交维修方案版本 |
| POST | `/api/plans/:id/effective` | 方案生效（与复运确认 CAS 互斥） |
| POST | `/api/scan/due` | 到期扫描/凭 run_id 断点续扫 |
| GET | `/api/trace/packages/:packNo` | 包装全链追溯 |

## 本地验证

执行测试（含拆分、合并/组合、一对一替换、分批核销、差异人工比对、延期与处置、
回执去重、并发互斥、扫描续扫、SQLite 重开恢复等接口测试）：

```bash
npm test
```

执行编译或构建检查：

```bash
npm run build
```

所有验证均在单个 Linux 应用环境中完成，不需要浏览器或独立运行的数据库、缓存与消息队列。
数据库默认位于 `data/trade.sqlite3`，可用环境变量 `DATABASE_PATH` 覆盖。
