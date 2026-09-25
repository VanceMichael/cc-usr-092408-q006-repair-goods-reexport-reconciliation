'use strict';

// 重量偏差容忍：单件偏差超过 max(0.5kg, 5%) 进入人工比对
const WEIGHT_TOLERANCE_RATIO = 0.05;
const WEIGHT_TOLERANCE_ABSOLUTE_KG = 0.5;

const EVENT_TYPES = ['detection', 'disassembly', 'replacement', 'reassembly'];
const APPROVAL_TYPES = ['extension', 'resale', 'scrap', 'formal_import'];
// 谱系事件产生的新部件类型
const COMPONENT_KIND_BY_EVENT = {
  disassembly: 'extracted',
  replacement: 'replacement',
  reassembly: 'assembled',
};

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

const nowIso = () => new Date().toISOString();

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ServiceError(400, 'VALIDATION', `${field} 不能为空`);
  }
  return value.trim();
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ServiceError(400, 'VALIDATION', `${field} 必须是正整数`);
  }
  return value;
}

function optionalWeight(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new ServiceError(400, 'VALIDATION', `${field} 必须是非负数字`);
  }
  return value;
}

// 统一规范为 YYYY-MM-DD，保证期限可按字符串比较
function normalizeDate(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ServiceError(400, 'VALIDATION', `${field} 不能为空`);
  }
  const time = Date.parse(value.trim());
  if (Number.isNaN(time)) {
    throw new ServiceError(400, 'VALIDATION', `${field} 不是有效日期`);
  }
  return new Date(time).toISOString().slice(0, 10);
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getApplicationRow(db, id) {
  const row = db.prepare('SELECT * FROM outbound_applications WHERE id = ?').get(id);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', `出境申请不存在: ${id}`);
  return row;
}

function getDeviceRow(db, id) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', `设备不存在: ${id}`);
  return row;
}

function getAccount(db, deviceId) {
  return db.prepare('SELECT * FROM device_accounts WHERE device_id = ?').get(deviceId);
}

// 剩余义务数量 = 总量 - 已核销 - 待处置 - 已处置
function outstandingOf(account) {
  return account.total_qty - account.verified_qty - account.pending_disposal_qty - account.disposed_qty;
}

function accountView(account) {
  return { ...account, outstanding_qty: outstandingOf(account) };
}

function hasLineage(db, deviceId) {
  return Boolean(db.prepare('SELECT 1 FROM lineage_events WHERE device_id = ? LIMIT 1').get(deviceId));
}

// 设备状态由台账与谱系推导，不落库，避免状态不一致
function deviceStatus(db, deviceId, account) {
  const settled = account.verified_qty + account.disposed_qty;
  if (settled >= account.total_qty && account.pending_disposal_qty === 0) return 'closed';
  if (settled > 0 || account.pending_disposal_qty > 0) return 'partially_settled';
  if (hasLineage(db, deviceId)) return 'in_repair';
  return 'exported';
}

function applicationProgress(db, applicationId) {
  const rows = db.prepare(
    `SELECT a.total_qty, a.verified_qty, a.pending_disposal_qty, a.disposed_qty
     FROM devices d JOIN device_accounts a ON a.device_id = d.id
     WHERE d.application_id = ?`,
  ).all(applicationId);
  const sum = rows.reduce(
    (acc, row) => ({
      total_qty: acc.total_qty + row.total_qty,
      verified_qty: acc.verified_qty + row.verified_qty,
      pending_disposal_qty: acc.pending_disposal_qty + row.pending_disposal_qty,
      disposed_qty: acc.disposed_qty + row.disposed_qty,
    }),
    { total_qty: 0, verified_qty: 0, pending_disposal_qty: 0, disposed_qty: 0 },
  );
  const outstanding = sum.total_qty - sum.verified_qty - sum.pending_disposal_qty - sum.disposed_qty;
  let state = 'declared';
  if (sum.total_qty > 0 && outstanding === 0 && sum.pending_disposal_qty === 0) {
    state = 'closed';
  } else if (sum.verified_qty + sum.pending_disposal_qty + sum.disposed_qty > 0) {
    state = 'partially_settled';
  } else {
    const repairing = db.prepare(
      'SELECT 1 FROM lineage_events e JOIN devices d ON d.id = e.device_id WHERE d.application_id = ? LIMIT 1',
    ).get(applicationId);
    if (repairing) state = 'in_repair';
  }
  return { ...sum, outstanding_qty: outstanding, state };
}

// ---------- 出境申请 ----------

function createOutboundApplication(db, payload) {
  const applicationNo = requireString(payload.application_no, 'application_no');
  const declarationNo = requireString(payload.declaration_no, 'declaration_no');
  const repairDeadline = normalizeDate(payload.repair_deadline, 'repair_deadline');
  const repairer = requireString(payload.repairer, 'repairer');
  const status = payload.status === undefined ? 'declared' : requireString(payload.status, 'status');
  if (!Array.isArray(payload.devices) || payload.devices.length === 0) {
    throw new ServiceError(400, 'VALIDATION', 'devices 至少包含一台设备');
  }
  const seenSerials = new Set();
  const devices = payload.devices.map((device, i) => {
    const serialNo = requireString(device.serial_no, `devices[${i}].serial_no`);
    if (seenSerials.has(serialNo)) {
      throw new ServiceError(400, 'VALIDATION', `同一申请内序列号重复: ${serialNo}`);
    }
    seenSerials.add(serialNo);
    return {
      serial_no: serialNo,
      description: device.description === undefined ? '' : String(device.description),
      quantity: device.quantity === undefined ? 1 : requirePositiveInt(device.quantity, `devices[${i}].quantity`),
      weight_kg: optionalWeight(device.weight_kg, `devices[${i}].weight_kg`),
      accessories: (device.accessories || []).map((acc, j) => ({
        name: requireString(acc.name, `devices[${i}].accessories[${j}].name`),
        quantity: acc.quantity === undefined ? 1 : requirePositiveInt(acc.quantity, `devices[${i}].accessories[${j}].quantity`),
      })),
    };
  });

  return withTransaction(db, () => {
    if (db.prepare('SELECT 1 FROM outbound_applications WHERE application_no = ?').get(applicationNo)) {
      throw new ServiceError(409, 'DUPLICATE', `出境申请编号已存在: ${applicationNo}`);
    }
    const createdAt = nowIso();
    const applicationId = Number(
      db.prepare(
        `INSERT INTO outbound_applications(application_no, declaration_no, status, repair_deadline, repairer, version, created_at)
         VALUES (?,?,?,?,?,1,?)`,
      ).run(applicationNo, declarationNo, status, repairDeadline, repairer, createdAt).lastInsertRowid,
    );
    for (const device of devices) {
      const deviceId = Number(
        db.prepare(
          `INSERT INTO devices(application_id, serial_no, description, quantity, weight_kg, repair_deadline)
           VALUES (?,?,?,?,?,?)`,
        ).run(applicationId, device.serial_no, device.description, device.quantity, device.weight_kg, repairDeadline).lastInsertRowid,
      );
      db.prepare('INSERT INTO device_accounts(device_id, total_qty) VALUES (?, ?)').run(deviceId, device.quantity);
      for (const acc of device.accessories) {
        db.prepare('INSERT INTO accessories(device_id, name, quantity) VALUES (?,?,?)').run(deviceId, acc.name, acc.quantity);
      }
      // 每台设备以“整机”作为谱系根节点
      db.prepare(`INSERT INTO components(device_id, label, serial_no, kind, event_id) VALUES (?,?,?,?,NULL)`)
        .run(deviceId, '整机', device.serial_no, 'original');
    }
    return getApplication(db, applicationId);
  });
}

function getApplication(db, id) {
  const application = getApplicationRow(db, id);
  const devices = db.prepare('SELECT * FROM devices WHERE application_id = ? ORDER BY id').all(id).map((device) => ({
    ...device,
    status: deviceStatus(db, device.id, getAccount(db, device.id)),
    accessories: db.prepare('SELECT id, name, quantity FROM accessories WHERE device_id = ? ORDER BY id').all(device.id),
    account: accountView(getAccount(db, device.id)),
  }));
  return { ...application, devices, progress: applicationProgress(db, id) };
}

// ---------- 维修方案变更（与复运确认共用版本号） ----------

function addPlanChange(db, applicationId, payload) {
  const note = requireString(payload.note, 'note');
  const baseVersion = requirePositiveInt(payload.base_version, 'base_version');
  return withTransaction(db, () => {
    getApplicationRow(db, applicationId);
    const updated = db.prepare(
      'UPDATE outbound_applications SET version = version + 1 WHERE id = ? AND version = ?',
    ).run(applicationId, baseVersion);
    if (updated.changes === 0) {
      const current = db.prepare('SELECT version FROM outbound_applications WHERE id = ?').get(applicationId);
      throw new ServiceError(409, 'VERSION_CONFLICT', `版本冲突：当前版本 ${current.version}，提交版本 ${baseVersion}`);
    }
    const id = Number(
      db.prepare('INSERT INTO plan_changes(application_id, note, version, created_at) VALUES (?,?,?,?)')
        .run(applicationId, note, baseVersion + 1, nowIso()).lastInsertRowid,
    );
    return db.prepare('SELECT * FROM plan_changes WHERE id = ?').get(id);
  });
}

// ---------- 谱系 ----------

function normalizeLinks(eventType, rawLinks) {
  if (eventType === 'detection') {
    if (rawLinks.length > 0) throw new ServiceError(400, 'VALIDATION', '检测事件不携带谱系关系');
    return [];
  }
  if (rawLinks.length === 0) {
    throw new ServiceError(400, 'VALIDATION', `${eventType} 必须说明与原件的对应关系`);
  }
  return rawLinks.map((link, i) => {
    const from = link.from;
    const to = link.to;
    if (!Array.isArray(from) || from.length === 0) {
      throw new ServiceError(400, 'VALIDATION', `links[${i}].from 至少包含一个来源部件`);
    }
    from.forEach((id, j) => requirePositiveInt(id, `links[${i}].from[${j}]`));
    if (!Array.isArray(to) || to.length === 0) {
      throw new ServiceError(400, 'VALIDATION', `links[${i}].to 至少包含一个目标部件`);
    }
    let relation;
    if (eventType === 'replacement') {
      relation = requireString(link.relation, `links[${i}].relation`);
    } else {
      relation = link.relation === undefined ? 'combination' : requireString(link.relation, `links[${i}].relation`);
    }
    if (!['one_to_one', 'combination'].includes(relation)) {
      throw new ServiceError(400, 'VALIDATION', `links[${i}].relation 必须是 one_to_one 或 combination`);
    }
    if (eventType === 'disassembly' && from.length !== 1) {
      throw new ServiceError(400, 'VALIDATION', '拆解每次只能从一个部件拆出');
    }
    if (eventType === 'reassembly' && to.length !== 1) {
      throw new ServiceError(400, 'VALIDATION', '重新装配每次只能装配成一个部件');
    }
    if (relation === 'one_to_one' && (from.length !== 1 || to.length !== 1)) {
      throw new ServiceError(400, 'VALIDATION', '一对一替换要求来源与目标各一个部件');
    }
    if (eventType === 'replacement' && relation === 'combination' && from.length + to.length < 3) {
      throw new ServiceError(400, 'VALIDATION', '组合替换至少涉及两个以上部件，否则应使用一对一');
    }
    return { from, to, relation };
  });
}

function addLineageEvent(db, deviceId, payload) {
  const device = getDeviceRow(db, deviceId);
  const eventType = requireString(payload.event_type, 'event_type');
  if (!EVENT_TYPES.includes(eventType)) {
    throw new ServiceError(400, 'VALIDATION', `event_type 必须是 ${EVENT_TYPES.join('/')}`);
  }
  const note = payload.note === undefined ? '' : String(payload.note);
  const rawLinks = payload.links === undefined ? [] : payload.links;
  if (!Array.isArray(rawLinks)) throw new ServiceError(400, 'VALIDATION', 'links 必须是数组');
  const links = normalizeLinks(eventType, rawLinks);

  return withTransaction(db, () => {
    for (const link of links) {
      for (const fromId of link.from) {
        const component = db.prepare('SELECT 1 FROM components WHERE id = ? AND device_id = ?').get(fromId, deviceId);
        if (!component) throw new ServiceError(400, 'VALIDATION', `来源部件不属于该设备: ${fromId}`);
      }
    }
    const eventId = Number(
      db.prepare('INSERT INTO lineage_events(device_id, event_type, note, created_at) VALUES (?,?,?,?)')
        .run(deviceId, eventType, note, nowIso()).lastInsertRowid,
    );
    const createdComponents = [];
    const linkRows = [];
    links.forEach((link, i) => {
      const toIds = link.to.map((target, j) => {
        if (typeof target === 'number') {
          const component = db.prepare('SELECT 1 FROM components WHERE id = ? AND device_id = ?').get(target, deviceId);
          if (!component) throw new ServiceError(400, 'VALIDATION', `目标部件不属于该设备: ${target}`);
          return target;
        }
        const label = requireString(target && target.label, `links[${i}].to[${j}].label`);
        const componentId = Number(
          db.prepare('INSERT INTO components(device_id, label, serial_no, kind, event_id) VALUES (?,?,?,?,?)')
            .run(deviceId, label, target.serial_no === undefined ? null : String(target.serial_no), COMPONENT_KIND_BY_EVENT[eventType], eventId)
            .lastInsertRowid,
        );
        createdComponents.push(componentId);
        return componentId;
      });
      for (const fromId of link.from) {
        for (const toId of toIds) {
          db.prepare('INSERT INTO lineage_links(event_id, from_component_id, to_component_id, relation) VALUES (?,?,?,?)')
            .run(eventId, fromId, toId, link.relation);
          linkRows.push({ from_component_id: fromId, to_component_id: toId, relation: link.relation });
        }
      }
    });
    return getLineageEvent(db, eventId);
  });
}

function getLineageEvent(db, eventId) {
  const event = db.prepare('SELECT * FROM lineage_events WHERE id = ?').get(eventId);
  if (!event) throw new ServiceError(404, 'NOT_FOUND', `谱系事件不存在: ${eventId}`);
  return { ...event, links: listEventLinks(db, eventId) };
}

function listEventLinks(db, eventId) {
  return db.prepare(
    `SELECT l.id, l.relation, l.from_component_id, l.to_component_id,
            cf.label AS from_label, ct.label AS to_label, ct.serial_no AS to_serial_no, ct.kind AS to_kind
     FROM lineage_links l
     JOIN components cf ON cf.id = l.from_component_id
     JOIN components ct ON ct.id = l.to_component_id
     WHERE l.event_id = ? ORDER BY l.id`,
  ).all(eventId);
}

function listLineageEvents(db, deviceId) {
  return db.prepare('SELECT * FROM lineage_events WHERE device_id = ? ORDER BY id').all(deviceId)
    .map((event) => ({ ...event, links: listEventLinks(db, event.id) }));
}

function getDevice(db, deviceId) {
  const device = getDeviceRow(db, deviceId);
  const account = getAccount(db, deviceId);
  return {
    ...device,
    status: deviceStatus(db, deviceId, account),
    accessories: db.prepare('SELECT id, name, quantity FROM accessories WHERE device_id = ? ORDER BY id').all(deviceId),
    account: accountView(account),
    components: db.prepare('SELECT * FROM components WHERE device_id = ? ORDER BY id').all(deviceId),
    lineage_events: listLineageEvents(db, deviceId),
    approvals: db.prepare('SELECT * FROM approvals WHERE device_id = ? ORDER BY id').all(deviceId),
    discrepancies: db.prepare('SELECT * FROM discrepancies WHERE device_id = ? ORDER BY id').all(deviceId),
  };
}

// ---------- 复运批次与确认 ----------

function getShipment(db, id) {
  const shipment = db.prepare('SELECT * FROM return_shipments WHERE id = ?').get(id);
  if (!shipment) throw new ServiceError(404, 'NOT_FOUND', `复运批次不存在: ${id}`);
  const items = db.prepare('SELECT * FROM return_items WHERE shipment_id = ? ORDER BY id').all(id);
  return { ...shipment, items };
}

function createReturnShipment(db, applicationId, payload) {
  getApplicationRow(db, applicationId);
  const packageNo = requireString(payload.package_no, 'package_no');
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new ServiceError(400, 'VALIDATION', 'items 至少包含一条复运明细');
  }
  const items = payload.items.map((item, i) => ({
    device_id: requirePositiveInt(item.device_id, `items[${i}].device_id`),
    serial_no: requireString(item.serial_no, `items[${i}].serial_no`),
    declared_qty: requirePositiveInt(item.declared_qty, `items[${i}].declared_qty`),
    quantity: requirePositiveInt(item.quantity, `items[${i}].quantity`),
    weight_kg: optionalWeight(item.weight_kg, `items[${i}].weight_kg`),
  }));
  return withTransaction(db, () => {
    if (db.prepare('SELECT 1 FROM return_shipments WHERE package_no = ?').get(packageNo)) {
      throw new ServiceError(409, 'DUPLICATE', `返运包装号已存在: ${packageNo}`);
    }
    for (const item of items) {
      const device = db.prepare('SELECT application_id FROM devices WHERE id = ?').get(item.device_id);
      if (!device) throw new ServiceError(404, 'NOT_FOUND', `设备不存在: ${item.device_id}`);
      if (device.application_id !== applicationId) {
        throw new ServiceError(400, 'VALIDATION', `设备 ${item.device_id} 不属于该出境申请`);
      }
    }
    const shipmentId = Number(
      db.prepare(
        `INSERT INTO return_shipments(application_id, package_no, carrier_receipt_no, status, created_at)
         VALUES (?,?,?,?,?)`,
      ).run(applicationId, packageNo, payload.carrier_receipt_no === undefined ? null : String(payload.carrier_receipt_no), 'received', nowIso()).lastInsertRowid,
    );
    for (const item of items) {
      db.prepare(
        `INSERT INTO return_items(shipment_id, device_id, serial_no, declared_qty, quantity, weight_kg, status)
         VALUES (?,?,?,?,?,?,'pending')`,
      ).run(shipmentId, item.device_id, item.serial_no, item.declared_qty, item.quantity, item.weight_kg);
    }
    return getShipment(db, shipmentId);
  });
}

function insertDiscrepancy(db, { deviceId, shipmentId, returnItemId, type, quantity, detail }) {
  const id = Number(
    db.prepare(
      `INSERT INTO discrepancies(device_id, shipment_id, return_item_id, type, quantity, detail, status, created_at)
       VALUES (?,?,?,?,?,?, 'open', ?)`,
    ).run(deviceId, shipmentId, returnItemId, type, quantity, detail, nowIso()).lastInsertRowid,
  );
  return db.prepare('SELECT * FROM discrepancies WHERE id = ?').get(id);
}

// 单条明细的核销判定：任何差异都只挂起该明细，不影响同批其他明细
function processReturnItem(db, shipment, item) {
  const device = getDeviceRow(db, item.device_id);
  const account = getAccount(db, item.device_id);
  const discrepancies = [];
  let held = false;
  const hold = (type, quantity, detail) => {
    held = true;
    discrepancies.push(insertDiscrepancy(db, {
      deviceId: item.device_id, shipmentId: shipment.id, returnItemId: item.id, type, quantity, detail,
    }));
  };

  if (item.serial_no !== device.serial_no) {
    hold('serial_change', item.quantity, JSON.stringify({ expected: device.serial_no, actual: item.serial_no }));
  }
  if (device.weight_kg !== null && item.weight_kg !== null) {
    const expected = device.weight_kg;
    const actualPerUnit = item.weight_kg / item.quantity;
    const tolerance = Math.max(WEIGHT_TOLERANCE_ABSOLUTE_KG, expected * WEIGHT_TOLERANCE_RATIO);
    if (Math.abs(actualPerUnit - expected) > tolerance) {
      hold('weight_deviation', item.quantity, JSON.stringify({
        expected_per_unit: expected, actual_per_unit: actualPerUnit, tolerance,
      }));
    }
  }
  if (!held && item.quantity > outstandingOf(account)) {
    // 已核销 + 待处置 + 本批数量超过出境总量：增件挂起，保证两类数量不重叠
    hold('overage', item.quantity, JSON.stringify({ capacity: outstandingOf(account), arrived: item.quantity }));
  }
  if (held) {
    db.prepare(`UPDATE return_items SET status = 'held' WHERE id = ?`).run(item.id);
    return { item_id: item.id, device_id: item.device_id, outcome: 'held', discrepancies };
  }

  if (item.quantity > item.declared_qty) {
    // 实到多于申报：申报部分先核销，超出部分进人工比对
    discrepancies.push(insertDiscrepancy(db, {
      deviceId: item.device_id,
      shipmentId: shipment.id,
      returnItemId: item.id,
      type: 'overage',
      quantity: item.quantity - item.declared_qty,
      detail: JSON.stringify({ declared: item.declared_qty, arrived: item.quantity }),
    }));
  }
  const verifiedNow = Math.min(item.quantity, item.declared_qty);
  db.prepare('UPDATE device_accounts SET verified_qty = verified_qty + ? WHERE device_id = ?').run(verifiedNow, item.device_id);
  db.prepare(`UPDATE return_items SET status = 'verified' WHERE id = ?`).run(item.id);
  if (item.quantity < item.declared_qty) {
    // 少件：实到部分核销，缺少部分进人工比对，后续批次不能将其覆盖
    discrepancies.push(insertDiscrepancy(db, {
      deviceId: item.device_id,
      shipmentId: shipment.id,
      returnItemId: item.id,
      type: 'shortage',
      quantity: item.declared_qty - item.quantity,
      detail: JSON.stringify({ declared: item.declared_qty, arrived: item.quantity }),
    }));
  }
  return { item_id: item.id, device_id: item.device_id, outcome: 'verified', verified_qty: verifiedNow, discrepancies };
}

function confirmReturnShipment(db, shipmentId, payload) {
  const baseVersion = requirePositiveInt(payload.base_version, 'base_version');
  return withTransaction(db, () => {
    const shipment = db.prepare('SELECT * FROM return_shipments WHERE id = ?').get(shipmentId);
    if (!shipment) throw new ServiceError(404, 'NOT_FOUND', `复运批次不存在: ${shipmentId}`);
    if (shipment.status !== 'received') {
      throw new ServiceError(409, 'STATE_CONFLICT', `批次 ${shipmentId} 已确认，不能重复核销`);
    }
    // 复运确认与维修方案变更争抢同一版本号，只有一个生效
    const updated = db.prepare(
      'UPDATE outbound_applications SET version = version + 1 WHERE id = ? AND version = ?',
    ).run(shipment.application_id, baseVersion);
    if (updated.changes === 0) {
      const current = db.prepare('SELECT version FROM outbound_applications WHERE id = ?').get(shipment.application_id);
      throw new ServiceError(409, 'VERSION_CONFLICT', `版本冲突：当前版本 ${current.version}，提交版本 ${baseVersion}`);
    }
    const items = db.prepare('SELECT * FROM return_items WHERE shipment_id = ? ORDER BY id').all(shipmentId);
    const results = items.map((item) => processReturnItem(db, shipment, item));
    db.prepare(`UPDATE return_shipments SET status = 'confirmed', confirmed_at = ?, base_version = ? WHERE id = ?`)
      .run(nowIso(), baseVersion, shipmentId);
    return { shipment: getShipment(db, shipmentId), results, version: baseVersion + 1 };
  });
}

// ---------- 人工比对 ----------

function resolveDiscrepancy(db, discrepancyId, payload) {
  const action = requireString(payload.action, 'action');
  if (!['apply', 'dismiss'].includes(action)) {
    throw new ServiceError(400, 'VALIDATION', 'action 必须是 apply 或 dismiss');
  }
  return withTransaction(db, () => {
    const discrepancy = db.prepare('SELECT * FROM discrepancies WHERE id = ?').get(discrepancyId);
    if (!discrepancy) throw new ServiceError(404, 'NOT_FOUND', `比对记录不存在: ${discrepancyId}`);
    if (discrepancy.status !== 'open') {
      throw new ServiceError(409, 'STATE_CONFLICT', '比对记录已处理，不能重复操作');
    }
    if (action === 'apply') {
      const account = getAccount(db, discrepancy.device_id);
      const item = discrepancy.return_item_id
        ? db.prepare('SELECT * FROM return_items WHERE id = ?').get(discrepancy.return_item_id)
        : null;
      let quantityToApply = 0;
      if (item && item.status === 'held') quantityToApply = item.quantity;
      else if (discrepancy.type === 'overage' && discrepancy.quantity > 0) quantityToApply = discrepancy.quantity;
      else throw new ServiceError(400, 'VALIDATION', '该比对记录没有可核销的数量');
      if (quantityToApply > outstandingOf(account)) {
        throw new ServiceError(409, 'QUANTITY_OVERLAP', `核销后与待处置数量重叠：剩余可核销 ${outstandingOf(account)}，申请 ${quantityToApply}`);
      }
      db.prepare('UPDATE device_accounts SET verified_qty = verified_qty + ? WHERE device_id = ?')
        .run(quantityToApply, discrepancy.device_id);
      if (item && item.status === 'held') {
        db.prepare(`UPDATE return_items SET status = 'verified' WHERE id = ?`).run(item.id);
      }
    }
    const resolution = payload.note === undefined ? action : `${action}: ${String(payload.note)}`;
    db.prepare(`UPDATE discrepancies SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?`)
      .run(nowIso(), resolution, discrepancyId);
    return db.prepare('SELECT * FROM discrepancies WHERE id = ?').get(discrepancyId);
  });
}

// ---------- 离线承运回执 ----------

function recordCarrierReceipt(db, payload) {
  const receiptNo = requireString(payload.receipt_no, 'receipt_no');
  let shipmentId = null;
  if (payload.shipment_id !== undefined && payload.shipment_id !== null) {
    shipmentId = requirePositiveInt(payload.shipment_id, 'shipment_id');
    if (!db.prepare('SELECT 1 FROM return_shipments WHERE id = ?').get(shipmentId)) {
      throw new ServiceError(404, 'NOT_FOUND', `复运批次不存在: ${shipmentId}`);
    }
  }
  const existing = db.prepare('SELECT * FROM carrier_receipts WHERE receipt_no = ?').get(receiptNo);
  if (existing) return { receipt: existing, deduplicated: true };
  try {
    const id = Number(
      db.prepare('INSERT INTO carrier_receipts(receipt_no, shipment_id, payload, received_at) VALUES (?,?,?,?)')
        .run(receiptNo, shipmentId, payload.payload === undefined ? '' : String(payload.payload), nowIso()).lastInsertRowid,
    );
    return { receipt: db.prepare('SELECT * FROM carrier_receipts WHERE id = ?').get(id), deduplicated: false };
  } catch (err) {
    // 并发下唯一约束兜底，仍按流水号去重
    if (String(err.message).includes('UNIQUE')) {
      return { receipt: db.prepare('SELECT * FROM carrier_receipts WHERE receipt_no = ?').get(receiptNo), deduplicated: true };
    }
    throw err;
  }
}

// ---------- 独立审批：延期、转售、报废、正式进口 ----------

function requestApproval(db, deviceId, payload) {
  const device = getDeviceRow(db, deviceId);
  const type = requireString(payload.type, 'type');
  if (!APPROVAL_TYPES.includes(type)) {
    throw new ServiceError(400, 'VALIDATION', `审批类型必须是 ${APPROVAL_TYPES.join('/')}`);
  }
  let quantity = 0;
  let newDeadline = null;
  if (type === 'extension') {
    newDeadline = normalizeDate(payload.new_deadline, 'new_deadline');
  } else {
    quantity = requirePositiveInt(payload.quantity, 'quantity');
  }
  const account = getAccount(db, deviceId);
  if (deviceStatus(db, deviceId, account) === 'closed') {
    throw new ServiceError(409, 'STATE_CONFLICT', '设备已核销关闭，不能再发起审批');
  }
  const id = Number(
    db.prepare(
      `INSERT INTO approvals(device_id, type, quantity, reason, status, new_deadline, created_at)
       VALUES (?,?,?,?, 'pending', ?, ?)`,
    ).run(deviceId, type, quantity, payload.reason === undefined ? '' : String(payload.reason), newDeadline, nowIso()).lastInsertRowid,
  );
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
}

function decideApproval(db, approvalId, payload) {
  const decision = requireString(payload.decision, 'decision');
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ServiceError(400, 'VALIDATION', 'decision 必须是 approved 或 rejected');
  }
  return withTransaction(db, () => {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!approval) throw new ServiceError(404, 'NOT_FOUND', `审批不存在: ${approvalId}`);
    if (approval.status !== 'pending') {
      throw new ServiceError(409, 'STATE_CONFLICT', '审批已有结论，不能重复处理');
    }
    const device = getDeviceRow(db, approval.device_id);
    const decidedAt = nowIso();
    if (decision === 'rejected') {
      db.prepare(`UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?`).run(decidedAt, approvalId);
    } else if (approval.type === 'extension') {
      // 延期：原期限延续到新期限，审批单保留原期限
      db.prepare('UPDATE devices SET repair_deadline = ? WHERE id = ?').run(approval.new_deadline, device.id);
      db.prepare(
        `UPDATE approvals SET status = 'approved', decided_at = ?, previous_deadline = ?, deadline_action = 'extend' WHERE id = ?`,
      ).run(decidedAt, device.repair_deadline, approvalId);
    } else {
      // 转售/报废/正式进口：数量转入待处置，与已核销不重叠
      const account = getAccount(db, device.id);
      if (approval.quantity > outstandingOf(account)) {
        throw new ServiceError(409, 'QUANTITY_OVERLAP', `待处置数量与已核销重叠：剩余可处置 ${outstandingOf(account)}，申请 ${approval.quantity}`);
      }
      db.prepare('UPDATE device_accounts SET pending_disposal_qty = pending_disposal_qty + ? WHERE device_id = ?')
        .run(approval.quantity, device.id);
      db.prepare(
        `UPDATE approvals SET status = 'approved', decided_at = ?, previous_deadline = ?, deadline_action = 'stop' WHERE id = ?`,
      ).run(decidedAt, device.repair_deadline, approvalId);
      // 全部数量都有去向时，原期限停止
      if (outstandingOf(account) - approval.quantity === 0 && device.deadline_stopped_at === null) {
        db.prepare('UPDATE devices SET deadline_stopped_at = ? WHERE id = ?').run(decidedAt, device.id);
      }
    }
    return db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  });
}

// 处置完成确认：待处置 -> 已处置
function confirmDisposal(db, deviceId, payload) {
  const quantity = requirePositiveInt(payload.quantity, 'quantity');
  return withTransaction(db, () => {
    getDeviceRow(db, deviceId);
    const account = getAccount(db, deviceId);
    if (quantity > account.pending_disposal_qty) {
      throw new ServiceError(409, 'QUANTITY_OVERLAP', `处置数量超过待处置余量 ${account.pending_disposal_qty}`);
    }
    db.prepare('UPDATE device_accounts SET pending_disposal_qty = pending_disposal_qty - ?, disposed_qty = disposed_qty + ? WHERE device_id = ?')
      .run(quantity, quantity, deviceId);
    return accountView(getAccount(db, deviceId));
  });
}

// ---------- 到期扫描：稳定游标，中断后继续，不重复标记 ----------

function scanDue(db, payload) {
  const asOf = normalizeDate(payload.as_of, 'as_of');
  const batchSize = payload.batch_size === undefined ? 50 : requirePositiveInt(payload.batch_size, 'batch_size');
  if (batchSize > 500) throw new ServiceError(400, 'VALIDATION', 'batch_size 不能超过 500');
  return withTransaction(db, () => {
    let state = db.prepare('SELECT * FROM scan_state WHERE id = 1').get();
    if (!state) {
      db.prepare('INSERT INTO scan_state(id, epoch, last_device_id, done, updated_at) VALUES (1, 0, 0, 1, ?)').run(nowIso());
      state = db.prepare('SELECT * FROM scan_state WHERE id = 1').get();
    }
    let epoch = state.epoch;
    let cursor = state.last_device_id;
    if (state.done) {
      // 上一轮已扫完，开启新一轮
      epoch += 1;
      cursor = 0;
    }
    // 游标按设备 id 稳定推进，候选集与“是否到期”判定分离，避免跳过未到期设备后卡住
    const candidates = db.prepare('SELECT id FROM devices WHERE id > ? ORDER BY id LIMIT ?').all(cursor, batchSize);
    const marked = [];
    const markedAt = nowIso();
    for (const { id } of candidates) {
      const row = db.prepare(
        `SELECT d.repair_deadline, d.deadline_stopped_at,
                a.total_qty, a.verified_qty, a.pending_disposal_qty, a.disposed_qty
         FROM devices d JOIN device_accounts a ON a.device_id = d.id WHERE d.id = ?`,
      ).get(id);
      const outstanding = row.total_qty - row.verified_qty - row.pending_disposal_qty - row.disposed_qty;
      if (row.deadline_stopped_at === null && row.repair_deadline <= asOf && outstanding > 0) {
        const reason = `维修期限 ${row.repair_deadline} 已到期，未核销数量 ${outstanding}`;
        const inserted = db.prepare(
          'INSERT OR IGNORE INTO unverified_marks(device_id, epoch, reason, marked_at) VALUES (?,?,?,?)',
        ).run(id, epoch, reason, markedAt);
        if (inserted.changes > 0) marked.push({ device_id: id, reason });
      }
      cursor = id;
    }
    const done = candidates.length < batchSize ? 1 : 0;
    db.prepare('UPDATE scan_state SET epoch = ?, last_device_id = ?, done = ?, updated_at = ? WHERE id = 1')
      .run(epoch, cursor, done, nowIso());
    return { epoch, scanned: candidates.length, marked, done: done === 1, cursor };
  });
}

function listUnverified(db) {
  const state = db.prepare('SELECT * FROM scan_state WHERE id = 1').get();
  if (!state) return { epoch: 0, items: [] };
  const items = db.prepare(
    `SELECT m.id AS mark_id, m.device_id, m.reason, m.marked_at,
            d.serial_no, d.repair_deadline, a.application_no, a.declaration_no,
            acc.total_qty, acc.verified_qty, acc.pending_disposal_qty, acc.disposed_qty
     FROM unverified_marks m
     JOIN devices d ON d.id = m.device_id
     JOIN outbound_applications a ON a.id = d.application_id
     JOIN device_accounts acc ON acc.device_id = d.id
     WHERE m.epoch = ? ORDER BY m.device_id`,
  ).all(state.epoch).map((row) => ({
    mark_id: row.mark_id,
    device_id: row.device_id,
    serial_no: row.serial_no,
    application_no: row.application_no,
    declaration_no: row.declaration_no,
    repair_deadline: row.repair_deadline,
    reason: row.reason,
    marked_at: row.marked_at,
    outstanding_qty: row.total_qty - row.verified_qty - row.pending_disposal_qty - row.disposed_qty,
  }));
  return { epoch: state.epoch, items };
}

// ---------- 追溯查询 ----------

function traceShipment(db, shipmentId) {
  const shipment = db.prepare('SELECT * FROM return_shipments WHERE id = ?').get(shipmentId);
  if (!shipment) throw new ServiceError(404, 'NOT_FOUND', `复运批次不存在: ${shipmentId}`);
  const application = getApplicationRow(db, shipment.application_id);
  const items = db.prepare('SELECT * FROM return_items WHERE shipment_id = ? ORDER BY id').all(shipmentId).map((item) => {
    const device = getDeviceRow(db, item.device_id);
    const account = accountView(getAccount(db, item.device_id));
    const discrepancies = db.prepare('SELECT * FROM discrepancies WHERE device_id = ? ORDER BY id').all(item.device_id);
    return {
      item,
      device: {
        id: device.id,
        serial_no: device.serial_no,
        description: device.description,
        status: deviceStatus(db, device.id, getAccount(db, device.id)),
      },
      lineage_events: listLineageEvents(db, item.device_id),
      approvals: db.prepare('SELECT * FROM approvals WHERE device_id = ? ORDER BY id').all(item.device_id),
      discrepancies,
      account,
      obligations: {
        outstanding_qty: account.outstanding_qty,
        repair_deadline: device.repair_deadline,
        deadline_stopped_at: device.deadline_stopped_at,
        open_discrepancies: discrepancies.filter((d) => d.status === 'open').length,
      },
    };
  });
  return { shipment, application, items };
}

module.exports = {
  ServiceError,
  createOutboundApplication,
  getApplication,
  addPlanChange,
  addLineageEvent,
  getDevice,
  createReturnShipment,
  getShipment,
  confirmReturnShipment,
  resolveDiscrepancy,
  recordCarrierReceipt,
  requestApproval,
  decideApproval,
  confirmDisposal,
  scanDue,
  listUnverified,
  traceShipment,
};
