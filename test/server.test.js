const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const { openDatabase } = require('../src/database');
const { createApp } = require('../src/server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-chain-'));
let seq = 0;
const dbPath = () => path.join(TMP, `db-${process.pid}-${seq += 1}.sqlite3`);

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const activeEnvs = [];
async function start(file) {
  const db = openDatabase(file);
  const server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = (method, urlPath, body) => request(server, method, urlPath, body);
  const env = {
    db,
    api,
    stop: async () => {
      await new Promise((r) => server.close(r));
      db.close();
      const idx = activeEnvs.indexOf(env);
      if (idx >= 0) activeEnvs.splice(idx, 1);
    },
  };
  activeEnvs.push(env);
  return env;
}

// 断言失败也要释放端口与数据库，避免进程挂住
test.after(async () => {
  await Promise.all(activeEnvs.splice(0).map((env) => env.stop()));
});


let declSeq = 0;
async function declareAndApprove(api, overrides = {}) {
  const payload = {
    customs_declaration_no: `DEC-${process.pid}-${declSeq += 1}`,
    applicant: '某精密仪器公司',
    allowed_repairers: ['OVERSEAS-REPAIR-CO'],
    items: [{
      serial_no: `SN-${declSeq}`,
      model: 'MICRO-9000',
      description: '精密测量仪',
      quantity: 1,
      weight_kg: 10,
      repair_deadline: '2099-12-31T00:00:00Z',
      attachments: [],
    }],
    ...overrides,
  };
  const created = await api('POST', '/api/applications', payload);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api('POST', `/api/applications/${created.body.id}/decision`, { decision: 'approved' });
  assert.equal(decided.status, 200);
  return decided.body;
}

const rootPart = (app) => app.items[0].parts.find((p) => p.is_root === 1);

// ---------- 基线 ----------

test('健康接口与SQLite迁移可用', async () => {
  const db = openDatabase(':memory:');
  const versions = db.prepare('SELECT version FROM schema_versions ORDER BY version').all();
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  db.close();

  const env = await start(dbPath());
  const health = await env.api('GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  await env.stop();
});

// ---------- 出境申请固定要素 ----------

test('出境申请固定原报关单/序列号/附件/期限/承修方，未批准不得维修', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api, {
    items: [{
      serial_no: 'SN-FIX-1',
      model: 'X1',
      quantity: 1,
      weight_kg: 12,
      repair_deadline: '2099-06-30T00:00:00Z',
      attachments: [{ name: '标准探头', serial_no: 'PRB-1', quantity: 1, weight_kg: 0.5 }],
    }],
  });
  const item = app.items[0];
  assert.equal(item.serial_no, 'SN-FIX-1');
  assert.equal(item.attachments[0].serial_no, 'PRB-1');
  assert.deepEqual(app.allowed_repairers, ['OVERSEAS-REPAIR-CO']);
  assert.equal(item.parts.length, 2); // 原机 + 附件各自为可核销根部件

  // 同一原报关单不可重复申报
  const dup = await env.api('POST', '/api/applications', {
    customs_declaration_no: app.customs_declaration_no,
    allowed_repairers: ['X'],
    items: [{ serial_no: 'S', repair_deadline: '2099-01-01T00:00:00Z' }],
  });
  assert.equal(dup.status, 409);

  // 承修方不在允许名单
  const forbidden = await env.api('POST', `/api/items/${item.id}/events`,
    { action: 'detect', actor: 'NOT-ALLOWED' });
  assert.equal(forbidden.status, 403);

  // 允许承修方可登记检测
  const detect = await env.api('POST', `/api/items/${item.id}/events`,
    { action: 'detect', actor: 'OVERSEAS-REPAIR-CO', detail: { result: '主板故障' } });
  assert.equal(detect.status, 201);
  assert.equal(detect.body.events.at(-1).action, 'detect');
  await env.stop();
});

test('未批准申请不得追加维修事件', async () => {
  const env = await start(dbPath());
  const created = await env.api('POST', '/api/applications', {
    customs_declaration_no: `DEC-RAW-${seq += 1}`,
    allowed_repairers: ['R'],
    items: [{ serial_no: 'SN-RAW', repair_deadline: '2099-01-01T00:00:00Z' }],
  });
  const itemId = created.body.items[0].id;
  const res = await env.api('POST', `/api/items/${itemId}/events`, { action: 'detect', actor: 'R' });
  assert.equal(res.status, 409);
  await env.stop();
});

// ---------- 一对一替换 ----------

test('一对一替换：新件与原件数量相等并保留谱系链接', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api);
  const itemId = app.items[0].id;
  const oldPart = rootPart(app);

  const res = await env.api('POST', `/api/items/${itemId}/events`, {
    action: 'replace',
    actor: 'OVERSEAS-REPAIR-CO',
    note: '主板整体更换',
    mappings: [{
      relation: 'one_to_one',
      from_part_ids: [oldPart.id],
      to_part: { name: '新主板总成', serial_no: 'SN-FIX-1-NEW', quantity: 1, weight_kg: 9.8 },
    }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const evt = res.body.events.at(-1);
  assert.equal(evt.action, 'replace');
  assert.equal(evt.links[0].relation, 'one_to_one');
  const oldRefreshed = res.body.parts.find((p) => p.id === oldPart.id);
  assert.equal(oldRefreshed.state, 'inactive');
  const newPart = res.body.parts.find((p) => p.serial_no === 'SN-FIX-1-NEW');
  assert.equal(newPart.available_qty, 1);

  // 数量不守恒的一对一会被拒绝
  const bad = await env.api('POST', `/api/items/${itemId}/events`, {
    action: 'replace',
    actor: 'OVERSEAS-REPAIR-CO',
    mappings: [{
      relation: 'one_to_one',
      from_part_ids: [newPart.id],
      to_part: { name: 'X', quantity: 2 },
    }],
  });
  assert.equal(bad.status, 400);
  await env.stop();
});

test('替换必须声明一对一或组合对应，禁止无映射替换', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api);
  const res = await env.api('POST', `/api/items/${app.items[0].id}/events`, {
    action: 'replace', actor: 'OVERSEAS-REPAIR-CO', mappings: [],
  });
  assert.equal(res.status, 400);
  await env.stop();
});

// ---------- 拆分 + 分批核销不重叠 ----------

test('拆分后分批复运：已核销与待核销不重叠，全部核销后义务关闭', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api, {
    items: [{
      serial_no: 'SN-SPLIT', model: 'M', quantity: 2, weight_kg: 20,
      repair_deadline: '2099-12-31T00:00:00Z',
    }],
  });
  const itemId = app.items[0].id;
  const root = rootPart(app);

  const split = await env.api('POST', `/api/items/${itemId}/events`, {
    action: 'disassemble',
    actor: 'OVERSEAS-REPAIR-CO',
    mappings: [{
      relation: 'split',
      from_part_id: root.id,
      quantity: 2,
      to_parts: [
        { name: '子机A', serial_no: 'SN-SPLIT-A', quantity: 1, weight_kg: 10 },
        { name: '子机B', serial_no: 'SN-SPLIT-B', quantity: 1, weight_kg: 10 },
      ],
    }],
  });
  assert.equal(split.status, 201, JSON.stringify(split.body));
  const childA = split.body.parts.find((p) => p.serial_no === 'SN-SPLIT-A');
  const childB = split.body.parts.find((p) => p.serial_no === 'SN-SPLIT-B');
  assert.equal(split.body.events.at(-1).links.length, 2);

  // 拆出数量之和不等于拆解数量 -> 拒绝
  const badSplit = await declareAndApprove(env.api, {
    items: [{ serial_no: 'SN-SPLIT-BAD', quantity: 1, repair_deadline: '2099-12-31T00:00:00Z' }],
  });
  const bad = await env.api('POST', `/api/items/${badSplit.items[0].id}/events`, {
    action: 'disassemble', actor: 'OVERSEAS-REPAIR-CO',
    mappings: [{
      relation: 'split', from_part_id: rootPart(badSplit).id,
      to_parts: [{ name: 'a', quantity: 1 }, { name: 'b', quantity: 1 }],
    }],
  });
  assert.equal(bad.status, 400);

  // 第一批：子机A 复运
  const plan1 = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-A', expected_weight_kg: 10,
      lines: [{ part_id: childA.id, expected_serial_no: 'SN-SPLIT-A', expected_weight_kg: 10, qty: 1 }],
    }],
  });
  assert.equal(plan1.status, 201);
  const lineA = plan1.body.packages[0].lines[0];
  const confirm1 = await env.api('POST', `/api/return-batches/${plan1.body.id}/confirm`, {
    actuals: [{ line_id: lineA.id, present: true, actual_serial_no: 'SN-SPLIT-A', actual_weight_kg: 10 }],
    package_actuals: [{ pack_no: 'PACK-A', actual_weight_kg: 10 }],
  });
  assert.equal(confirm1.status, 200);
  assert.equal(confirm1.body.status, 'confirmed');

  const mid = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(mid.body.remaining_qty, 1);
  assert.equal(mid.body.state, 'open');

  // 再次对已核销完的子机A发运 -> 数量重叠 422，不能靠新清单覆盖
  const overlap = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-A2',
      lines: [{ part_id: childA.id, expected_serial_no: 'SN-SPLIT-A', qty: 1 }],
    }],
  });
  const lineOverlap = overlap.body.packages[0].lines[0];
  const confirmOverlap = await env.api('POST', `/api/return-batches/${overlap.body.id}/confirm`, {
    actuals: [{ line_id: lineOverlap.id, present: true }],
  });
  assert.equal(confirmOverlap.status, 422);
  assert.match(confirmOverlap.body.error, /重叠/);

  // 第二批：子机B 复运，义务关闭
  const plan2 = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-B',
      lines: [{ part_id: childB.id, expected_serial_no: 'SN-SPLIT-B', qty: 1 }],
    }],
  });
  const lineB = plan2.body.packages[0].lines[0];
  const confirm2 = await env.api('POST', `/api/return-batches/${plan2.body.id}/confirm`, {
    actuals: [{ line_id: lineB.id, present: true }],
  });
  assert.equal(confirm2.status, 200);
  const done = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(done.body.remaining_qty, 0);
  assert.equal(done.body.state, 'obligation_closed');
  // 两条 return 流水都保留
  assert.equal(done.body.ledger.filter((l) => l.source === 'return').length, 2);
  await env.stop();
});

// ---------- 合并 / 重新装配 ----------

test('拆解后重新装配为组合件（combination），谱系可回溯到原机', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api, {
    items: [{
      serial_no: 'SN-MERGE', quantity: 2, weight_kg: 20,
      repair_deadline: '2099-12-31T00:00:00Z',
    }],
  });
  const itemId = app.items[0].id;
  const root = rootPart(app);

  await env.api('POST', `/api/items/${itemId}/events`, {
    action: 'disassemble', actor: 'OVERSEAS-REPAIR-CO',
    mappings: [{
      relation: 'split', from_part_id: root.id, quantity: 2,
      to_parts: [
        { name: '模组A', serial_no: 'SN-MERGE-A', quantity: 1 },
        { name: '模组B', serial_no: 'SN-MERGE-B', quantity: 1 },
      ],
    }],
  });
  const genealogy = await (await env.api('GET', `/api/items/${itemId}/genealogy`)).body;
  const a = genealogy.parts.find((p) => p.serial_no === 'SN-MERGE-A');
  const b = genealogy.parts.find((p) => p.serial_no === 'SN-MERGE-B');

  const reassembled = await env.api('POST', `/api/items/${itemId}/events`, {
    action: 'reassemble', actor: 'OVERSEAS-REPAIR-CO', note: '两模组合并为翻新整机',
    mappings: [{
      relation: 'combination',
      from_part_ids: [a.id, b.id],
      to_part: { name: '翻新整机', serial_no: 'SN-MERGE-R', quantity: 2 },
    }],
  });
  assert.equal(reassembled.status, 201, JSON.stringify(reassembled.body));
  const evt = reassembled.body.events.at(-1);
  assert.equal(evt.action, 'reassemble');
  assert.deepEqual(evt.links.map((l) => l.relation), ['combination', 'combination']);
  const merged = reassembled.body.parts.find((p) => p.serial_no === 'SN-MERGE-R');
  assert.equal(merged.state, 'active');
  assert.equal(merged.available_qty, 2);

  // 组合替换（多原件 -> 一个新件）
  const app2 = await declareAndApprove(env.api, {
    items: [{
      serial_no: 'SN-CMB', quantity: 1, weight_kg: 5,
      attachments: [
        { name: '附件1', serial_no: 'AT-C1', quantity: 1 },
        { name: '附件2', serial_no: 'AT-C2', quantity: 1 },
      ],
      repair_deadline: '2099-12-31T00:00:00Z',
    }],
  });
  const item2 = app2.items[0].id;
  const att1 = app2.items[0].parts.find((p) => p.serial_no === 'AT-C1');
  const att2 = app2.items[0].parts.find((p) => p.serial_no === 'AT-C2');
  const cmb = await env.api('POST', `/api/items/${item2}/events`, {
    action: 'replace', actor: 'OVERSEAS-REPAIR-CO',
    mappings: [{
      relation: 'combination', from_part_ids: [att1.id, att2.id],
      to_part: { name: '合并替代组件', serial_no: 'AT-COMBINED', quantity: 2 },
    }],
  });
  assert.equal(cmb.status, 201, JSON.stringify(cmb.body));
  assert.equal(cmb.body.parts.find((p) => p.id === att1.id).state, 'inactive');
  await env.stop();
});

// ---------- 差异进人工：少件 / 增件 / 序列号变化 / 重量偏差 ----------

test('少件/增件/序列号变化/重量偏差进入人工比对，少件须独立审批了结', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api, {
    items: [{
      serial_no: 'SN-DIFF', quantity: 2, weight_kg: 20,
      repair_deadline: '2099-12-31T00:00:00Z',
    }],
  });
  const itemId = app.items[0].id;
  const root = rootPart(app);

  const plan = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [
      {
        pack_no: 'PACK-D1', expected_weight_kg: 10,
        lines: [{ part_id: root.id, expected_serial_no: 'SN-DIFF', expected_weight_kg: 10, qty: 1 }],
      },
      {
        pack_no: 'PACK-D2',
        lines: [{ part_id: root.id, expected_serial_no: 'SN-DIFF', qty: 1 }],
      },
    ],
  });
  const [pkg1, pkg2] = plan.body.packages;

  const confirm = await env.api('POST', `/api/return-batches/${plan.body.id}/confirm`, {
    package_actuals: [
      // 整箱重量偏差 10/12 = 20%，同时多出未申报增件
      {
        pack_no: 'PACK-D1', actual_weight_kg: 12,
        extras: [{ name: '多出的夹具', serial_no: 'EXTRA-1', quantity: 1 }],
      },
    ],
    actuals: [
      { line_id: pkg1.lines[0].id, present: true, actual_serial_no: 'SN-DIFF', actual_weight_kg: 10 },
      { line_id: pkg2.lines[0].id, present: false }, // 少件
    ],
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.status, 'pending_manual');
  // 不能靠最后一次清单覆盖：待人工裁决的批次禁止再次确认
  const reconfirm = await env.api('POST', `/api/return-batches/${plan.body.id}/confirm`, { actuals: [] });
  assert.equal(reconfirm.status, 409);
  const types = confirm.body.reviews.map((r) => r.type).sort();
  assert.deepEqual(types, ['extra_part', 'missing_part', 'weight_mismatch']);

  const status = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(status.body.remaining_qty, 1); // 少件那件未核销
  assert.equal(status.body.open_reviews, 3);
  const extraPart = status.body.parts.find((p) => p.state === 'extra');
  assert.ok(extraPart);

  // 少件不得直接核销
  const missing = confirm.body.reviews.find((r) => r.type === 'missing_part');
  const writeOff = await env.api('POST', `/api/manual-reviews/${missing.id}/resolve`,
    { decision: 'accepted', write_off: true });
  assert.equal(writeOff.status, 400);

  // 重量偏差与增件经人工接受
  for (const type of ['weight_mismatch', 'extra_part']) {
    const review = confirm.body.reviews.find((r) => r.type === type);
    const r = await env.api('POST', `/api/manual-reviews/${review.id}/resolve`,
      { decision: 'accepted', note: '人工核实无误' });
    assert.equal(r.status, 200);
  }
  // 仍有少件未裁决 -> 批次不能确认
  let batch = await env.api('GET', `/api/return-batches/${plan.body.id}`);
  assert.equal(batch.body.status, 'pending_manual');

  // 少件转报废独立审批，批准后核销剩余数量并停止期限
  const scrap = await env.api('POST', `/api/items/${itemId}/dispositions`,
    { type: 'scrap', reason: '运输途中灭失', payload: { quantity: 1 } });
  // 尚有 open 人工比对时不允许处置，先退回少件比对
  assert.equal(scrap.status, 409);
  const rejectMissing = await env.api('POST', `/api/manual-reviews/${missing.id}/resolve`,
    { decision: 'rejected', note: '转报废流程处置' });
  assert.equal(rejectMissing.status, 200);

  const scrap2 = await env.api('POST', `/api/items/${itemId}/dispositions`,
    { type: 'scrap', reason: '运输途中灭失', payload: { quantity: 1 } });
  assert.equal(scrap2.status, 201);
  const scrapDecided = await env.api('POST', `/api/dispositions/${scrap2.body.id}/decision`,
    { decision: 'approved' });
  assert.equal(scrapDecided.status, 200);
  assert.ok(scrapDecided.body.item.deadline_stopped_at);

  const finalStatus = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(finalStatus.body.remaining_qty, 0);
  assert.equal(finalStatus.body.state, 'obligation_closed');
  // 增件不占原义务、不被核销
  assert.equal(finalStatus.body.parts.find((p) => p.state === 'extra').settled_qty, 0);
  await env.stop();
});

test('序列号变化进人工，人工接受后按实物核销', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api, {
    items: [{ serial_no: 'SN-SER', weight_kg: 10, repair_deadline: '2099-12-31T00:00:00Z' }],
  });
  const itemId = app.items[0].id;
  const plan = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-S1',
      lines: [{ part_id: rootPart(app).id, expected_serial_no: 'SN-SER', qty: 1 }],
    }],
  });
  const lineId = plan.body.packages[0].lines[0].id;
  const confirm = await env.api('POST', `/api/return-batches/${plan.body.id}/confirm`, {
    actuals: [{ line_id: lineId, present: true, actual_serial_no: 'SN-SER-REPLACED' }],
  });
  assert.equal(confirm.body.status, 'pending_manual');
  const review = confirm.body.reviews.find((r) => r.type === 'serial_changed');
  assert.ok(review);
  // 确认时不能自动核销
  const s1 = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(s1.body.remaining_qty, 1);

  const resolved = await env.api('POST', `/api/manual-reviews/${review.id}/resolve`,
    { decision: 'accepted', note: '序列号铭牌更换，实物一致' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.batch.status, 'confirmed');
  const s2 = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(s2.body.remaining_qty, 0);
  assert.equal(s2.body.state, 'obligation_closed');
  await env.stop();
});

// ---------- 延期 / 转售 / 正式进口 ----------

test('延期走独立审批并保留期限延续轨迹；转售与正式进口分别核销', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api, {
    items: [{
      serial_no: 'SN-EXT', quantity: 4, repair_deadline: '2099-01-01T00:00:00Z',
    }],
  });
  const itemId = app.items[0].id;

  const ext = await env.api('POST', `/api/items/${itemId}/dispositions`,
    { type: 'extension', reason: '配件待运', payload: { new_deadline: '2099-06-30T00:00:00Z' } });
  assert.equal(ext.status, 201);
  const extDecided = await env.api('POST', `/api/dispositions/${ext.body.id}/decision`,
    { decision: 'approved' });
  assert.equal(extDecided.status, 200);
  assert.equal(extDecided.body.item.repair_deadline, '2099-06-30T00:00:00Z');
  assert.equal(extDecided.body.item.deadline_stopped_at, null); // 延期不是停止
  const withHistory = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(withHistory.body.deadline_history[0].change_type, 'extended');
  assert.equal(withHistory.body.deadline_history[0].old_deadline, '2099-01-01T00:00:00Z');

  // 新期限必须晚于当前期限
  const badExt = await env.api('POST', `/api/items/${itemId}/dispositions`,
    { type: 'extension', payload: { new_deadline: '2098-01-01T00:00:00Z' } });
  const badDecided = await env.api('POST', `/api/dispositions/${badExt.body.id}/decision`,
    { decision: 'approved' });
  assert.equal(badDecided.status, 400);

  // 转售 1 件：独立审批，期限停止，剩 3 件义务仍在（不关闭）
  const resale = await env.api('POST', `/api/items/${itemId}/dispositions`,
    { type: 'resale', payload: { quantity: 1 } });
  const resaleOk = await env.api('POST', `/api/dispositions/${resale.body.id}/decision`,
    { decision: 'approved' });
  assert.equal(resaleOk.status, 200);
  const afterResale = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(afterResale.body.remaining_qty, 3);
  assert.ok(afterResale.body.deadline_stopped_at);
  assert.equal(afterResale.body.state, 'open');
  assert.ok(afterResale.body.ledger.some((l) => l.source === 'resale' && l.qty === 1));

  // 正式进口剩余 3 件后关闭
  const fi = await env.api('POST', `/api/items/${itemId}/dispositions`,
    { type: 'formal_import', reason: '国内留购', payload: { quantity: 3 } });
  const fiOk = await env.api('POST', `/api/dispositions/${fi.body.id}/decision`,
    { decision: 'approved' });
  assert.equal(fiOk.status, 200);
  const closed = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(closed.body.remaining_qty, 0);
  assert.equal(closed.body.state, 'obligation_closed');
  assert.deepEqual(
    closed.body.deadline_history.map((h) => h.change_type),
    ['extended', 'stopped', 'stopped'],
  );

  // 超量处置 422
  const app2 = await declareAndApprove(env.api, {
    items: [{ serial_no: 'SN-OVR', quantity: 1, repair_deadline: '2099-12-31T00:00:00Z' }],
  });
  const over = await env.api('POST', `/api/items/${app2.items[0].id}/dispositions`,
    { type: 'scrap', payload: { quantity: 2 } });
  const overDecided = await env.api('POST', `/api/dispositions/${over.body.id}/decision`,
    { decision: 'approved' });
  assert.equal(overDecided.status, 422);
  await env.stop();
});

// ---------- 承运回执去重 ----------

test('离线承运回执按自身流水去重，可先到后绑定批次', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api);
  const itemId = app.items[0].id;
  const plan = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-RCP',
      lines: [{ part_id: rootPart(app).id, expected_serial_no: app.items[0].serial_no, qty: 1 }],
    }],
  });

  // 回执先离线到达（无批次）
  const first = await env.api('POST', '/api/carrier-receipts',
    { receipt_no: 'RCP-1001', payload: { carrier: 'DHL', pieces: 1 } });
  assert.equal(first.status, 201);
  assert.equal(first.body.duplicate, false);
  // 同一流水再次推送 -> 去重
  const again = await env.api('POST', '/api/carrier-receipts',
    { receipt_no: 'RCP-1001', payload: { carrier: 'DHL', pieces: 1 } });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);

  const linked = await env.api('POST', '/api/carrier-receipts/RCP-1001/link',
    { batch_id: plan.body.id });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.batch_id, plan.body.id);
  // 已绑定回执不可改绑
  const otherPlan = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-RCP2',
      lines: [{ part_id: rootPart(app).id, qty: 1 }],
    }],
  });
  const rebind = await env.api('POST', '/api/carrier-receipts/RCP-1001/link',
    { batch_id: otherPlan.body.id });
  assert.equal(rebind.status, 409);
  await env.stop();
});

// ---------- 复运确认与方案变更并发 ----------

test('复运确认与方案变更并发时只有一个版本生效', async () => {
  const env = await start(dbPath());
  const app = await declareAndApprove(env.api);
  const itemId = app.items[0].id;

  // 先建批次（锁定版本基线 0）
  const plan = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-CONC',
      lines: [{ part_id: rootPart(app).id, expected_serial_no: app.items[0].serial_no, qty: 1 }],
    }],
  });
  assert.equal(plan.body.state_version_base, 0);

  // 维修方案变更生效，推进版本
  const p1 = await env.api('POST', `/api/items/${itemId}/plans`,
    { content: { revision: 'v2', note: '增加检测工序' } });
  const eff1 = await env.api('POST', `/api/plans/${p1.body.id}/effective`, {});
  assert.equal(eff1.status, 200);
  assert.equal(eff1.body.status, 'effective');

  // 旧批次确认 -> 409
  const stale = await env.api('POST', `/api/return-batches/${plan.body.id}/confirm`, {});
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /并发/);

  // 同一时刻两个候选方案，只有一个能生效
  const p2 = await env.api('POST', `/api/items/${itemId}/plans`, { content: { revision: 'v3' } });
  const p3 = await env.api('POST', `/api/items/${itemId}/plans`, { content: { revision: 'v4' } });
  const eff2 = await env.api('POST', `/api/plans/${p2.body.id}/effective`, {});
  assert.equal(eff2.status, 200);
  // 旧 effective 已被取代为 superseded
  const plansAfterEff2 = (await env.api('GET', `/api/items/${itemId}`)).body.plans;
  assert.equal(plansAfterEff2.find((p) => p.id === p1.body.id).status, 'superseded');
  const eff3 = await env.api('POST', `/api/plans/${p3.body.id}/effective`, {});
  assert.equal(eff3.status, 409);
  const planRows = (await env.api('GET', `/api/items/${itemId}`)).body.plans;
  assert.equal(planRows.filter((p) => p.status === 'effective').length, 1);

  // 按新版本重建批次后可正常确认
  const plan2 = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'PACK-CONC2',
      lines: [{ part_id: rootPart(app).id, expected_serial_no: app.items[0].serial_no, qty: 1 }],
    }],
  });
  assert.equal(plan2.body.state_version_base, 2);
  const ok = await env.api('POST', `/api/return-batches/${plan2.body.id}/confirm`, {
    actuals: [{ line_id: plan2.body.packages[0].lines[0].id, present: true }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'confirmed');
  await env.stop();
});

// ---------- 到期扫描：稳定游标、中断续扫、不重复标记 ----------

test('到期扫描按稳定游标分页，中断续扫不重复标记', async () => {
  const env = await start(dbPath());
  // 两台已到期、一台未到期、一台到期但随后延期
  const expired1 = await declareAndApprove(env.api, {
    items: [{ serial_no: 'SN-DUE-1', repair_deadline: '2020-01-01T00:00:00Z' }],
  });
  const expired2 = await declareAndApprove(env.api, {
    items: [{ serial_no: 'SN-DUE-2', repair_deadline: '2020-02-01T00:00:00Z' }],
  });
  await declareAndApprove(env.api, {
    items: [{ serial_no: 'SN-FUTURE', repair_deadline: '2099-12-31T00:00:00Z' }],
  });
  const willExtend = await declareAndApprove(env.api, {
    items: [{ serial_no: 'SN-EXTEND', repair_deadline: '2020-03-01T00:00:00Z' }],
  });
  const ext = await env.api('POST', `/api/items/${willExtend.items[0].id}/dispositions`,
    { type: 'extension', payload: { new_deadline: '2099-06-30T00:00:00Z' } });
  await env.api('POST', `/api/dispositions/${ext.body.id}/decision`, { decision: 'approved' });

  // page_size=1：首次只标记一页，run 仍 running
  const page1 = await env.api('POST', '/api/scan/due', { page_size: 1 });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.done, false);
  assert.equal(page1.body.new_marked, 1);
  const runId = page1.body.run.run_id;

  // 中断后按 run_id 继续
  const page2 = await env.api('POST', '/api/scan/due', { run_id: runId });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.new_marked, 1);
  assert.equal(page2.body.resumed, true);

  // 候选只有两台到期设备（未到期/已延期不在内），第三页扫完
  const page3 = await env.api('POST', '/api/scan/due', { run_id: runId });
  assert.equal(page3.status, 200);
  assert.equal(page3.body.done, true);
  assert.equal(page3.body.new_marked, 0);
  const markedSerials = page3.body.listings.map((l) => l.serial_no).sort();
  assert.deepEqual(markedSerials, ['SN-DUE-1', 'SN-DUE-2']);

  // 已完成 run 再跑：不重复标记
  const replay = await env.api('POST', '/api/scan/due', { run_id: runId });
  assert.equal(replay.body.done, true);
  assert.equal(replay.body.new_marked, 0);
  assert.equal(replay.body.total_marked, 2);

  // 全新 run 结果稳定（延期设备仍不在清单）
  const fresh = await env.api('POST', '/api/scan/due', { page_size: 10 });
  assert.equal(fresh.body.listings.length, 2);

  // 已核销关闭的到期设备在下一次扫描中不再出现
  for (const appRef of [expired1, expired2]) {
    const disposition = await env.api('POST', `/api/items/${appRef.items[0].id}/dispositions`,
      { type: 'scrap', payload: { quantity: 1 } });
    await env.api('POST', `/api/dispositions/${disposition.body.id}/decision`, { decision: 'approved' });
  }
  const afterClose = await env.api('POST', '/api/scan/due', { page_size: 10 });
  assert.equal(afterClose.body.listings.length, 0);
  await env.stop();
});

// ---------- SQLite 重开后状态与谱系不丢失 + 包装全链追溯 ----------

test('SQLite 重开后状态与谱系不丢失，且可从包装追溯到原设备与剩余义务', async () => {
  const file = dbPath();
  let env = await start(file);
  const app = await declareAndApprove(env.api, {
    items: [{
      serial_no: 'SN-TRACE', quantity: 2, weight_kg: 20,
      repair_deadline: '2099-12-31T00:00:00Z',
      attachments: [{ name: '探头', serial_no: 'PRB-T', quantity: 1, weight_kg: 1 }],
    }],
  });
  const itemId = app.items[0].id;
  const root = rootPart(app);

  const split = await env.api('POST', `/api/items/${itemId}/events`, {
    action: 'disassemble', actor: 'OVERSEAS-REPAIR-CO',
    mappings: [{
      relation: 'split', from_part_id: root.id, quantity: 2,
      to_parts: [
        { name: '子机A', serial_no: 'SN-TRACE-A', quantity: 1, weight_kg: 10 },
        { name: '子机B', serial_no: 'SN-TRACE-B', quantity: 1, weight_kg: 10 },
      ],
    }],
  });
  const childA = split.body.parts.find((p) => p.serial_no === 'SN-TRACE-A');
  const batch = await env.api('POST', `/api/items/${itemId}/return-batches`, {
    packages: [{
      pack_no: 'TRACE-PACK-1', expected_weight_kg: 11,
      lines: [
        { part_id: childA.id, expected_serial_no: 'SN-TRACE-A', expected_weight_kg: 10, qty: 1 },
        { part_id: app.items[0].parts.find((p) => p.serial_no === 'PRB-T').id,
          expected_serial_no: 'PRB-T', qty: 1 },
      ],
    }],
  });
  const [l1, l2] = batch.body.packages[0].lines;
  await env.api('POST', `/api/return-batches/${batch.body.id}/confirm`, {
    package_actuals: [{ pack_no: 'TRACE-PACK-1', actual_weight_kg: 11 }],
    actuals: [
      { line_id: l1.id, present: true, actual_serial_no: 'SN-TRACE-A', actual_weight_kg: 10 },
      { line_id: l2.id, present: true, actual_serial_no: 'PRB-T' },
    ],
  });
  await env.api('POST', '/api/carrier-receipts',
    { receipt_no: 'RCP-TRACE', batch_id: batch.body.id });
  await env.stop();

  // 重开同一 SQLite 文件
  env = await start(file);
  const trace = await env.api('GET', '/api/trace/packages/TRACE-PACK-1');
  assert.equal(trace.status, 200, JSON.stringify(trace.body));
  assert.equal(trace.body.item.serial_no, 'SN-TRACE');
  assert.equal(trace.body.application.customs_declaration_no, app.customs_declaration_no);
  // 子机A 沿 split 链接回溯到原机根部件
  const childLine = trace.body.parts_in_package.find((p) => p.part?.serial_no === 'SN-TRACE-A');
  const rootNode = childLine.ancestry.at(-1);
  assert.equal(rootNode.is_root, true);
  assert.equal(rootNode.serial_no, 'SN-TRACE');
  assert.ok(childLine.ancestry.some((n) => n.via.some((v) => v.relation === 'split')));
  // 维修动作、审批、核销流水、剩余义务、回执全部可查
  assert.ok(trace.body.events.some((e) => e.action === 'disassemble'));
  assert.equal(trace.body.ledger.length, 2);
  assert.equal(trace.body.remaining_obligation, 1); // 子机B 尚未退
  assert.equal(trace.body.receipts[0].receipt_no, 'RCP-TRACE');
  assert.equal(trace.body.attachments[0].serial_no, 'PRB-T');

  const status = await env.api('GET', `/api/items/${itemId}`);
  assert.equal(status.body.state, 'open');
  assert.equal(status.body.remaining_qty, 1);
  assert.equal(status.body.parts.length, 4); // 原机 + 探头 + 两个子机
  await env.stop();
});
