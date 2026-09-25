# 跨境贸易事件版本归并

跨境贸易事件服务后端，当前已包含维修货物复运核销链：精密仪器临时出境维修后，对每个原序列号的检测、拆解、替换、重新装配、分批复运、延期/转售/报废/正式进口审批进行全链路留痕与核销，保证关务人员能证明每个原序列号最终是否按期复运或依法转入其他处置。

## 核销链能力

- **出境申请**（`POST /api/outbound-applications`）：固定原报关单号、设备序列号、附件清单、申报状态、维修期限与允许承修方；创建后不提供修改入口。
- **谱系追加**（`POST /api/devices/:id/lineage-events`）：检测、拆解、替换、重新装配只追加不修改；替换必须声明与原件的 `one_to_one` 或 `combination` 对应关系。
- **分批复运**（`POST .../return-shipments`、`POST /api/return-shipments/:id/confirm`）：同一原设备的已核销、待处置、已处置数量互不重叠（数据库 CHECK + 事务内预检）；少件、增件、序列号变化、重量偏差逐条进入人工比对（`POST /api/discrepancies/:id/resolve`），不会被后续清单覆盖。
- **独立审批**（`POST /api/devices/:id/approvals`、`POST /api/approvals/:id/decide`）：延期、转售、报废、正式进口四类审批互相独立；审批单记录原期限如何延续（`extend`）或停止（`stop`），义务全部有去向时期限自动停止。
- **离线承运回执**（`POST /api/carrier-receipts`）：按回执自身流水号去重，重复上报返回原记录。
- **并发控制**：复运确认与维修方案变更（`POST .../plan-changes`）争抢同一申请版本号，并发时只有一个生效，另一方收到 `409 VERSION_CONFLICT`。
- **到期扫描**（`POST /api/scan/due`、`GET /api/scan/unverified`）：按设备 id 稳定游标分页生成未核销清单，中断后从游标继续，同一轮内设备唯一标记不重复。
- **追溯查询**（`GET /api/return-shipments/:id/trace`）：从任一返运包装追到原设备、维修动作、审批记录与剩余义务。
- **持久化**：全部状态与谱系存于 SQLite（WAL），重开不丢失。

## 本地验证

执行测试：

```bash
npm test
```

执行编译或构建检查：

```bash
npm run build
```

所有验证均在单个 Linux 应用环境中完成，不需要浏览器或独立运行的数据库、缓存与消息队列。
