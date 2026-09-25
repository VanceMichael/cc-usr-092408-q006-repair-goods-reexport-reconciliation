const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { openDatabase } = require('../src/database');
const { createApp } = require('../src/app');

async function startServer(db) {
  const app = createApp(db);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function api(server, method, path, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function withServer(fn) {
  const db = openDatabase(':memory:');
  const server = await startServer(db);
  try {
    await fn({ db, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

function applicationPayload(overrides = {}) {
  return {
    application_no: 'APP-0001',
    declaration_no: 'DECL-2026-0001',
    repair_deadline: '2026-10-01',
    repairer: '慕尼黑精密维修中心',
    devices: [
      {
        serial_no: 'SN-A',
        quantity: 3,
        weight_kg: 10,
        description: '光谱仪',
        accessories: [{ name: '校准探头', quantity: 2 }, { name: '便携箱', quantity: 1 }],
      },
    ],
    ...overrides,
  };
}

async function createApplication(server, overrides = {}) {
  const result = await api(server, 'POST', '/api/outbound-applications', applicationPayload(overrides));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

test('出境申请固定原报关单、序列号、附件、申报状态、期限与承修方', async () => withServer(async ({ server }) => {
  const created = await createApplication(server, {
    devices: [
      {
        serial_no: 'SN-A',
        quantity: 2,
        weight_kg: 10,
        description: '光谱仪',
        accessories: [{ name: '校准探头', quantity: 2 }],
      },
      { serial_no: 'SN-B', quantity: 1, description: '示波器' },
    ],
  });
  assert.equal(created.declaration_no, 'DECL-2026-0001');
  assert.equal(created.status, 'declared');
  assert.equal(created.repair_deadline, '2026-10-01');
  assert.equal(created.repairer, '慕尼黑精密维修中心');
  assert.equal(created.version, 1);
  assert.equal(created.devices.length, 2);
  assert.deepEqual(created.devices[0].accessories, [
    { id: 1, name: '校准探头', quantity: 2 },
  ]);
  assert.equal(created.devices[0].account.total_qty, 2);
  assert.equal(created.devices[0].account.outstanding_qty, 2);

  const fetched = await api(server, 'GET', `/api/outbound-applications/${created.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.devices[1].serial_no, 'SN-B');
  assert.equal(fetched.body.progress.state, 'declared');

  // 缺承修方、缺设备、编号重复、序列号重复分别被拒绝
  const missingRepairer = await api(server, 'POST', '/api/outbound-applications', {
    application_no: 'APP-9001', declaration_no: 'D', repair_deadline: '2026-10-01', devices: [{ serial_no: 'X' }],
  });
  assert.equal(missingRepairer.status, 400);
  const noDevices = await api(server, 'POST', '/api/outbound-applications', {
    application_no: 'APP-9002', declaration_no: 'D', repair_deadline: '2026-10-01', repairer: 'R', devices: [],
  });
  assert.equal(noDevices.status, 400);
  const duplicate = await api(server, 'POST', '/api/outbound-applications', applicationPayload());
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'DUPLICATE');
  const duplicateSerial = await api(server, 'POST', '/api/outbound-applications', applicationPayload({
    application_no: 'APP-9003',
    devices: [{ serial_no: 'SN-A' }, { serial_no: 'SN-A' }],
  }));
  assert.equal(duplicateSerial.status, 400);
}));

test('谱系：检测、拆分、一对一替换、组合替换与重新装配逐次追加', async () => withServer(async ({ server }) => {
  const app = await createApplication(server, {
    devices: [{ serial_no: 'SN-B', quantity: 1, description: '示波器' }],
  });
  const deviceId = app.devices[0].id;

  const detection = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'detection', note: '开机自检，电源模块异常',
  });
  assert.equal(detection.status, 201);

  const device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.status, 'in_repair');
  const root = device.components.find((c) => c.kind === 'original');
  assert.equal(root.label, '整机');

  // 拆分：整机 -> 电源模块 + 采集板
  const split = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'disassembly',
    note: '拆出故障部件',
    links: [{ from: [root.id], to: [{ label: '电源模块' }, { label: '采集板' }] }],
  });
  assert.equal(split.status, 201);
  assert.equal(split.body.links.length, 2);
  assert.ok(split.body.links.every((l) => l.relation === 'combination'));

  const afterSplit = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  const power = afterSplit.components.find((c) => c.label === '电源模块');
  const board = afterSplit.components.find((c) => c.label === '采集板');
  assert.equal(power.kind, 'extracted');

  // 一对一替换：电源模块 -> 新电源模块（新序列号）
  const replaceOne = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'replacement',
    note: '电源模块整体更换',
    links: [{ from: [power.id], to: [{ label: '电源模块', serial_no: 'PSU-NEW-77' }], relation: 'one_to_one' }],
  });
  assert.equal(replaceOne.status, 201);
  assert.equal(replaceOne.body.links[0].relation, 'one_to_one');

  // 组合替换：新电源模块 + 采集板 -> 一体化主板
  const afterOne = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  const newPower = afterOne.components.find((c) => c.serial_no === 'PSU-NEW-77');
  const replaceCombo = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'replacement',
    note: '两件组合替换为一体化主板',
    links: [{ from: [newPower.id, board.id], to: [{ label: '一体化主板', serial_no: 'MB-900' }], relation: 'combination' }],
  });
  assert.equal(replaceCombo.status, 201);

  // 重新装配（合并）：一体化主板 -> 整机
  const merge = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'reassembly',
    note: '重新装配为整机',
    links: [{ from: [newPower.id, board.id], to: [{ label: '整机', serial_no: 'SN-B' }] }],
  });
  assert.equal(merge.status, 201);
  assert.equal(merge.body.links.length, 2);

  const finalDevice = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.deepEqual(
    finalDevice.lineage_events.map((e) => e.event_type),
    ['detection', 'disassembly', 'replacement', 'replacement', 'reassembly'],
  );
  const mainboard = finalDevice.components.find((c) => c.serial_no === 'MB-900');
  assert.equal(mainboard.kind, 'replacement');

  // 替换必须说明对应关系；一对一不允许一对多；检测不携带谱系
  const noLinks = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'replacement', note: '缺少对应关系',
  });
  assert.equal(noLinks.status, 400);
  const noRelation = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'replacement',
    links: [{ from: [root.id], to: [{ label: 'X' }] }],
  });
  assert.equal(noRelation.status, 400);
  const badOneToOne = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'replacement',
    links: [{ from: [root.id, power.id], to: [{ label: 'X' }], relation: 'one_to_one' }],
  });
  assert.equal(badOneToOne.status, 400);
  const detectionWithLinks = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'detection',
    links: [{ from: [root.id], to: [{ label: 'X' }] }],
  });
  assert.equal(detectionWithLinks.status, 400);
  // 来源部件必须属于本设备
  const foreignComponent = await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'disassembly',
    links: [{ from: [99999], to: [{ label: 'X' }] }],
  });
  assert.equal(foreignComponent.status, 400);
}));

test('分批复运核销：已核销与待处置数量不重叠，处置确认后关闭', async () => withServer(async ({ server }) => {
  const app = await createApplication(server); // SN-A，数量 3
  const deviceId = app.devices[0].id;

  // 第一批复运 1 件并确认
  const s1 = await api(server, 'POST', `/api/outbound-applications/${app.id}/return-shipments`, {
    package_no: 'PKG-1',
    items: [{ device_id: deviceId, serial_no: 'SN-A', declared_qty: 1, quantity: 1, weight_kg: 10 }],
  });
  assert.equal(s1.status, 201);
  const c1 = await api(server, 'POST', `/api/return-shipments/${s1.body.id}/confirm`, { base_version: 1 });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.results[0].outcome, 'verified');

  // 待处置申请超过剩余可处置数量被拒（已核销 1，余 2，申请 3）
  const resaleTooMuch = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, { type: 'resale', quantity: 3 });
  const tooMuchDecision = await api(server, 'POST', `/api/approvals/${resaleTooMuch.body.id}/decide`, { decision: 'approved' });
  assert.equal(tooMuchDecision.status, 409);
  assert.equal(tooMuchDecision.body.error.code, 'QUANTITY_OVERLAP');

  // 1 件转售获批，进入待处置
  const resale = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, { type: 'resale', quantity: 1 });
  const resaleDecision = await api(server, 'POST', `/api/approvals/${resale.body.id}/decide`, { decision: 'approved' });
  assert.equal(resaleDecision.status, 200);

  // 第二批复运 2 件：容量只剩 1，整批挂起为增件比对
  const s2 = await api(server, 'POST', `/api/outbound-applications/${app.id}/return-shipments`, {
    package_no: 'PKG-2',
    items: [{ device_id: deviceId, serial_no: 'SN-A', declared_qty: 2, quantity: 2 }],
  });
  const c2 = await api(server, 'POST', `/api/return-shipments/${s2.body.id}/confirm`, { base_version: 2 });
  assert.equal(c2.status, 200);
  assert.equal(c2.body.results[0].outcome, 'held');
  assert.equal(c2.body.results[0].discrepancies[0].type, 'overage');

  // 第三批复运 1 件：正好占满剩余容量
  const s3 = await api(server, 'POST', `/api/outbound-applications/${app.id}/return-shipments`, {
    package_no: 'PKG-3',
    items: [{ device_id: deviceId, serial_no: 'SN-A', declared_qty: 1, quantity: 1 }],
  });
  const c3 = await api(server, 'POST', `/api/return-shipments/${s3.body.id}/confirm`, { base_version: 3 });
  assert.equal(c3.body.results[0].outcome, 'verified');

  let device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.account.verified_qty, 2);
  assert.equal(device.account.pending_disposal_qty, 1);
  assert.equal(device.account.outstanding_qty, 0);
  assert.equal(device.status, 'partially_settled');

  // 处置确认：待处置 -> 已处置，设备关闭
  const disposal = await api(server, 'POST', `/api/devices/${deviceId}/disposals`, { quantity: 1 });
  assert.equal(disposal.status, 200);
  assert.equal(disposal.body.disposed_qty, 1);
  device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.status, 'closed');

  // 挂起的增件比对只能逐条处理，不随后续批次消失
  const overage = device.discrepancies.find((d) => d.type === 'overage');
  assert.equal(overage.status, 'open');
  const dismissed = await api(server, 'POST', `/api/discrepancies/${overage.id}/resolve`, { action: 'dismiss', note: '承修方退运' });
  assert.equal(dismissed.body.status, 'resolved');
}));

test('少件、增件、序列号变化、重量偏差进入人工比对且不被后续清单覆盖', async () => withServer(async ({ server }) => {
  const app = await createApplication(server, {
    devices: [{ serial_no: 'SN-A', quantity: 4, weight_kg: 10 }],
  });
  const deviceId = app.devices[0].id;
  let version = 1;
  const confirmBatch = async (packageNo, item) => {
    const shipment = await api(server, 'POST', `/api/outbound-applications/${app.id}/return-shipments`, {
      package_no: packageNo,
      items: [{ device_id: deviceId, ...item }],
    });
    assert.equal(shipment.status, 201);
    const confirmed = await api(server, 'POST', `/api/return-shipments/${shipment.body.id}/confirm`, { base_version: version });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    version += 1;
    return confirmed.body;
  };

  // 序列号变化（承修方更换整机）-> 挂起
  const r1 = await confirmBatch('PKG-S1', { serial_no: 'SN-A-NEW', declared_qty: 1, quantity: 1, weight_kg: 10 });
  assert.equal(r1.results[0].outcome, 'held');
  assert.equal(r1.results[0].discrepancies[0].type, 'serial_change');

  // 少件：申报 2 实到 1 -> 实到核销，缺少 1 件进比对
  const r2 = await confirmBatch('PKG-S2', { serial_no: 'SN-A', declared_qty: 2, quantity: 1, weight_kg: 10 });
  assert.equal(r2.results[0].outcome, 'verified');
  assert.equal(r2.results[0].verified_qty, 1);
  assert.equal(r2.results[0].discrepancies[0].type, 'shortage');

  // 重量偏差 4kg 超过容忍 -> 挂起
  const r3 = await confirmBatch('PKG-S3', { serial_no: 'SN-A', declared_qty: 1, quantity: 1, weight_kg: 6 });
  assert.equal(r3.results[0].outcome, 'held');
  assert.equal(r3.results[0].discrepancies[0].type, 'weight_deviation');

  // 增件：申报 1 实到 2 -> 申报部分核销，超出 1 件进比对
  const r4 = await confirmBatch('PKG-S4', { serial_no: 'SN-A', declared_qty: 1, quantity: 2, weight_kg: 20.4 });
  assert.equal(r4.results[0].outcome, 'verified');
  assert.equal(r4.results[0].verified_qty, 1);
  assert.equal(r4.results[0].discrepancies[0].type, 'overage');
  assert.equal(r4.results[0].discrepancies[0].quantity, 1);

  // 正常批次
  const r5 = await confirmBatch('PKG-S5', { serial_no: 'SN-A', declared_qty: 1, quantity: 1, weight_kg: 10 });
  assert.equal(r5.results[0].outcome, 'verified');

  // 后续清单没有覆盖此前的比对记录
  let device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  const openTypes = device.discrepancies.filter((d) => d.status === 'open').map((d) => d.type).sort();
  assert.deepEqual(openTypes, ['overage', 'serial_change', 'shortage', 'weight_deviation']);
  assert.equal(device.account.verified_qty, 3);

  // 人工比对：序列号变化经谱系核对后核销
  const serialChange = device.discrepancies.find((d) => d.type === 'serial_change');
  const applied = await api(server, 'POST', `/api/discrepancies/${serialChange.id}/resolve`, {
    action: 'apply', note: '与替换事件 PSU-NEW-77 对应',
  });
  assert.equal(applied.status, 200);
  device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.account.verified_qty, 4);
  assert.equal(device.account.outstanding_qty, 0);

  // 余量为 0 后增件不能再核销，只能关闭比对
  const overage = device.discrepancies.find((d) => d.type === 'overage');
  const applyOverage = await api(server, 'POST', `/api/discrepancies/${overage.id}/resolve`, { action: 'apply' });
  assert.equal(applyOverage.status, 409);
  assert.equal(applyOverage.body.error.code, 'QUANTITY_OVERLAP');
  const dismissOverage = await api(server, 'POST', `/api/discrepancies/${overage.id}/resolve`, { action: 'dismiss', note: '承修方备件误发' });
  assert.equal(dismissOverage.status, 200);

  // 其余比对逐条关闭，设备最终关闭
  for (const type of ['weight_deviation', 'shortage']) {
    const target = device.discrepancies.find((d) => d.type === type);
    const resolved = await api(server, 'POST', `/api/discrepancies/${target.id}/resolve`, { action: 'dismiss' });
    assert.equal(resolved.status, 200);
  }
  device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.status, 'closed');
  assert.ok(device.discrepancies.every((d) => d.status === 'resolved'));
  // 已处理的比对不能重复操作
  const again = await api(server, 'POST', `/api/discrepancies/${serialChange.id}/resolve`, { action: 'apply' });
  assert.equal(again.status, 409);
}));

test('延期、转售、报废、正式进口分别走独立审批并保留期限去向', async () => withServer(async ({ server }) => {
  const app = await createApplication(server, {
    repair_deadline: '2026-10-01',
    devices: [{ serial_no: 'SN-A', quantity: 2 }],
  });
  const deviceId = app.devices[0].id;

  // 延期必须给新期限
  const badExtension = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, { type: 'extension' });
  assert.equal(badExtension.status, 400);

  // 延期获批：期限延续，审批单保留原期限
  const extension = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, {
    type: 'extension', new_deadline: '2026-12-31', reason: '承修方排产延迟',
  });
  assert.equal(extension.status, 201);
  const extensionDecision = await api(server, 'POST', `/api/approvals/${extension.body.id}/decide`, { decision: 'approved' });
  assert.equal(extensionDecision.body.deadline_action, 'extend');
  assert.equal(extensionDecision.body.previous_deadline, '2026-10-01');
  assert.equal(extensionDecision.body.new_deadline, '2026-12-31');
  let device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.repair_deadline, '2026-12-31');
  assert.equal(device.deadline_stopped_at, null);

  // 转售 1 件获批：期限对该部分停止，设备仍有剩余义务
  const resale = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, { type: 'resale', quantity: 1 });
  const resaleDecision = await api(server, 'POST', `/api/approvals/${resale.body.id}/decide`, { decision: 'approved' });
  assert.equal(resaleDecision.body.deadline_action, 'stop');
  assert.equal(resaleDecision.body.previous_deadline, '2026-12-31');
  device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.account.pending_disposal_qty, 1);
  assert.equal(device.deadline_stopped_at, null);

  // 报废剩余 1 件获批：义务全部有去向，原期限停止
  const scrap = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, { type: 'scrap', quantity: 1 });
  await api(server, 'POST', `/api/approvals/${scrap.body.id}/decide`, { decision: 'approved' });
  device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.account.pending_disposal_qty, 2);
  assert.ok(device.deadline_stopped_at !== null);

  // 正式进口被驳回：台账不变
  const formalImport = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, { type: 'formal_import', quantity: 1 });
  const rejected = await api(server, 'POST', `/api/approvals/${formalImport.body.id}/decide`, { decision: 'rejected' });
  assert.equal(rejected.body.status, 'rejected');
  device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  assert.equal(device.account.pending_disposal_qty, 2);

  // 审批不能重复定论；非法类型被拒
  const again = await api(server, 'POST', `/api/approvals/${formalImport.body.id}/decide`, { decision: 'approved' });
  assert.equal(again.status, 409);
  const badType = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, { type: 'donate', quantity: 1 });
  assert.equal(badType.status, 400);
}));

test('复运确认与维修方案变更并发时只有一个版本生效', async () => withServer(async ({ server }) => {
  const app = await createApplication(server, {
    devices: [{ serial_no: 'SN-A', quantity: 1 }],
  });
  const deviceId = app.devices[0].id;
  const shipment = await api(server, 'POST', `/api/outbound-applications/${app.id}/return-shipments`, {
    package_no: 'PKG-C1',
    items: [{ device_id: deviceId, serial_no: 'SN-A', declared_qty: 1, quantity: 1 }],
  });

  // 方案变更先生效：版本 1 -> 2
  const planChange = await api(server, 'POST', `/api/outbound-applications/${app.id}/plan-changes`, {
    note: '承修方改为更换整机', base_version: 1,
  });
  assert.equal(planChange.status, 201);
  assert.equal(planChange.body.version, 2);

  // 持旧版本的复运确认失败
  const staleConfirm = await api(server, 'POST', `/api/return-shipments/${shipment.body.id}/confirm`, { base_version: 1 });
  assert.equal(staleConfirm.status, 409);
  assert.equal(staleConfirm.body.error.code, 'VERSION_CONFLICT');

  // 以最新版本确认成功：版本 2 -> 3
  const confirmed = await api(server, 'POST', `/api/return-shipments/${shipment.body.id}/confirm`, { base_version: 2 });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.version, 3);

  // 旧版本的方案变更同样失败；已确认批次不能重复确认
  const stalePlan = await api(server, 'POST', `/api/outbound-applications/${app.id}/plan-changes`, {
    note: '过期方案', base_version: 2,
  });
  assert.equal(stalePlan.status, 409);
  const reconfirm = await api(server, 'POST', `/api/return-shipments/${shipment.body.id}/confirm`, { base_version: 3 });
  assert.equal(reconfirm.status, 409);
  assert.equal(reconfirm.body.error.code, 'STATE_CONFLICT');
}));

test('离线承运回执按自身流水号去重', async () => withServer(async ({ db, server }) => {
  const first = await api(server, 'POST', '/api/carrier-receipts', { receipt_no: 'CR-100', payload: '已提货' });
  assert.equal(first.status, 201);
  assert.equal(first.body.deduplicated, false);

  const replay = await api(server, 'POST', '/api/carrier-receipts', { receipt_no: 'CR-100', payload: '重复上报' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.deduplicated, true);
  assert.equal(replay.body.receipt.id, first.body.receipt.id);

  const count = db.prepare('SELECT COUNT(*) AS c FROM carrier_receipts').get().c;
  assert.equal(count, 1);

  const missingShipment = await api(server, 'POST', '/api/carrier-receipts', { receipt_no: 'CR-101', shipment_id: 999 });
  assert.equal(missingShipment.status, 404);
}));

test('到期扫描按稳定游标生成未核销清单，中断后继续且不重复标记', async () => withServer(async ({ db, server }) => {
  const app1 = await createApplication(server, {
    application_no: 'APP-DUE-1',
    devices: [
      { serial_no: 'SN-1', quantity: 1, description: '已到期' },
      { serial_no: 'SN-2', quantity: 1, description: '已到期' },
      { serial_no: 'SN-3', quantity: 1, description: '未到期' },
    ],
    repair_deadline: '2026-09-01',
  });
  // 第三台设备期限未到：单独调整其期限
  const app2 = await createApplication(server, {
    application_no: 'APP-DUE-2',
    repair_deadline: '2026-09-05',
    devices: [{ serial_no: 'SN-4', quantity: 1, description: '已核销' }],
  });
  const doneDeviceId = app2.devices[0].id;
  const shipment = await api(server, 'POST', `/api/outbound-applications/${app2.id}/return-shipments`, {
    package_no: 'PKG-DUE',
    items: [{ device_id: doneDeviceId, serial_no: 'SN-4', declared_qty: 1, quantity: 1 }],
  });
  await api(server, 'POST', `/api/return-shipments/${shipment.body.id}/confirm`, { base_version: 1 });

  const [d1, d2, d3] = app1.devices.map((d) => d.id);
  // 直接修改第三台设备期限到未来，构造“未到期”
  db.prepare('UPDATE devices SET repair_deadline = ? WHERE id = ?').run('2027-06-01', d3);

  // 第一批：游标推进到 d2，标记两台到期设备
  const scan1 = await api(server, 'POST', '/api/scan/due', { as_of: '2026-09-25', batch_size: 2 });
  assert.equal(scan1.body.epoch, 1);
  assert.deepEqual(scan1.body.marked.map((m) => m.device_id), [d1, d2]);
  assert.equal(scan1.body.done, false);

  // 中断后继续：未到期与已核销设备不产生标记
  const scan2 = await api(server, 'POST', '/api/scan/due', { as_of: '2026-09-25', batch_size: 2 });
  assert.equal(scan2.body.scanned, 2);
  assert.equal(scan2.body.marked.length, 0);
  assert.equal(scan2.body.done, false);
  const scan3 = await api(server, 'POST', '/api/scan/due', { as_of: '2026-09-25', batch_size: 2 });
  assert.equal(scan3.body.done, true);

  // 同一轮内不会重复标记
  const dupCount = db.prepare('SELECT COUNT(*) AS c FROM unverified_marks WHERE device_id = ? AND epoch = 1').get(d1).c;
  assert.equal(dupCount, 1);

  // 新一轮扫描重新生成清单
  const scan4 = await api(server, 'POST', '/api/scan/due', { as_of: '2026-09-25', batch_size: 2 });
  assert.equal(scan4.body.epoch, 2);
  assert.deepEqual(scan4.body.marked.map((m) => m.device_id), [d1, d2]);

  const unverified = await api(server, 'GET', '/api/scan/unverified');
  assert.equal(unverified.body.epoch, 2);
  assert.deepEqual(unverified.body.items.map((i) => i.serial_no), ['SN-1', 'SN-2']);
  assert.ok(unverified.body.items.every((i) => i.outstanding_qty === 1));
}));

test('查询端从返运包装追到原设备、维修动作、审批与剩余义务', async () => withServer(async ({ server }) => {
  const app = await createApplication(server, {
    devices: [{ serial_no: 'SN-X', quantity: 2, weight_kg: 10 }],
  });
  const deviceId = app.devices[0].id;

  const device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  const root = device.components.find((c) => c.kind === 'original');
  await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, { event_type: 'detection', note: '检测' });
  await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'disassembly',
    links: [{ from: [root.id], to: [{ label: '光学舱' }, { label: '控制板' }] }],
  });
  const split = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
  const optical = split.components.find((c) => c.label === '光学舱');
  await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
    event_type: 'replacement',
    links: [{ from: [optical.id], to: [{ label: '光学舱', serial_no: 'OPT-2' }], relation: 'one_to_one' }],
  });

  const extension = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, {
    type: 'extension', new_deadline: '2026-11-30',
  });
  await api(server, 'POST', `/api/approvals/${extension.body.id}/decide`, { decision: 'approved' });

  const shipment = await api(server, 'POST', `/api/outbound-applications/${app.id}/return-shipments`, {
    package_no: 'PKG-TRACE',
    carrier_receipt_no: 'CR-TRACE-1',
    items: [{ device_id: deviceId, serial_no: 'SN-X-NEW', declared_qty: 1, quantity: 1 }],
  });
  await api(server, 'POST', `/api/return-shipments/${shipment.body.id}/confirm`, { base_version: 1 });

  const trace = await api(server, 'GET', `/api/return-shipments/${shipment.body.id}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.application.application_no, 'APP-0001');
  const traced = trace.body.items[0];
  assert.equal(traced.device.serial_no, 'SN-X');
  assert.deepEqual(
    traced.lineage_events.map((e) => e.event_type),
    ['detection', 'disassembly', 'replacement'],
  );
  assert.equal(traced.approvals.length, 1);
  assert.equal(traced.approvals[0].deadline_action, 'extend');
  assert.equal(traced.obligations.outstanding_qty, 2);
  assert.equal(traced.obligations.repair_deadline, '2026-11-30');
  assert.equal(traced.obligations.open_discrepancies, 1);
  assert.equal(traced.discrepancies[0].type, 'serial_change');
}));

test('SQLite 重开后状态与谱系不丢失', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-chain-'));
  const file = join(dir, 'chain.sqlite3');

  let deviceId;
  let applicationId;
  {
    const db = openDatabase(file);
    const server = await startServer(db);
    const app = await createApplication(server, {
      devices: [{ serial_no: 'SN-P', quantity: 2, weight_kg: 5 }],
    });
    applicationId = app.id;
    deviceId = app.devices[0].id;
    const device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
    const root = device.components.find((c) => c.kind === 'original');
    await api(server, 'POST', `/api/devices/${deviceId}/lineage-events`, {
      event_type: 'disassembly',
      links: [{ from: [root.id], to: [{ label: '传感器' }, { label: '外壳' }] }],
    });
    const extension = await api(server, 'POST', `/api/devices/${deviceId}/approvals`, {
      type: 'extension', new_deadline: '2027-01-15',
    });
    await api(server, 'POST', `/api/approvals/${extension.body.id}/decide`, { decision: 'approved' });
    const shipment = await api(server, 'POST', `/api/outbound-applications/${applicationId}/return-shipments`, {
      package_no: 'PKG-P',
      items: [{ device_id: deviceId, serial_no: 'SN-P', declared_qty: 1, quantity: 1 }],
    });
    await api(server, 'POST', `/api/return-shipments/${shipment.body.id}/confirm`, { base_version: 1 });
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  {
    const db = openDatabase(file);
    const server = await startServer(db);
    const device = (await api(server, 'GET', `/api/devices/${deviceId}`)).body;
    assert.equal(device.account.verified_qty, 1);
    assert.equal(device.account.outstanding_qty, 1);
    assert.equal(device.repair_deadline, '2027-01-15');
    assert.equal(device.lineage_events.length, 1);
    assert.equal(device.components.length, 3);
    assert.equal(device.approvals.length, 1);
    assert.equal(device.approvals[0].deadline_action, 'extend');

    const application = (await api(server, 'GET', `/api/outbound-applications/${applicationId}`)).body;
    assert.equal(application.version, 2);
    assert.equal(application.progress.state, 'partially_settled');

    const versions = db.prepare('SELECT version FROM schema_versions ORDER BY version').all().map((row) => row.version);
    assert.deepEqual(versions, [1, 2]);
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
