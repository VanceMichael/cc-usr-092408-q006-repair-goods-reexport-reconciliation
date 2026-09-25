'use strict';

// 维修货物复运核销链服务层
//
// 不变量：
// 1. 每个可核销部件（parts 行）满足 initial_qty = available + consumed_qty + settled_qty。
// 2. 已核销数量以 disposition_ledger 为唯一权威来源（settled_qty 为其缓存），
//    任何清单都不能"覆盖"历史，只能追加。
// 3. 复运确认与维修方案变更以 items.state_version 做乐观并发：
//    批次建立时记录版本基线，确认时版本不一致即 409；两者竞争只有一个版本生效。
// 4. 到期扫描先固化候选快照，再以自增游标分页标记，中断续扫不重复、不漏。

const { randomUUID } = require('node:crypto');

const id = (prefix) => `${prefix}_${randomUUID()}`;
const now = () => new Date().toISOString();
const sum = (numbers) => numbers.reduce((a, b) => a + b, 0);
const WEIGHT_TOL = 0.05; // 重量偏差 5%

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const assert400 = (cond, message, details) => {
  if (!cond) throw new HttpError(400, message, details);
};

function createRepairService(db) {
  const q = {
    app: db.prepare('SELECT * FROM applications WHERE id=?'),
    appByDecl: db.prepare('SELECT * FROM applications WHERE customs_declaration_no=?'),
    insertApp: db.prepare(
      'INSERT INTO applications(id,customs_declaration_no,status,applicant,allowed_repairers_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ),
    updateAppStatus: db.prepare('UPDATE applications SET status=?, updated_at=? WHERE id=?'),
    insertItem: db.prepare(
      `INSERT INTO items(id,app_id,seq,serial_no,model,description,quantity,unit,weight_kg,
        repair_deadline,state,state_version,plan_version,created_at)
       VALUES(@id,@app_id,@seq,@serial_no,@model,@description,@quantity,@unit,@weight_kg,
        @repair_deadline,'open',0,0,@created_at)`,
    ),
    item: db.prepare('SELECT * FROM items WHERE id=?'),
    itemsByApp: db.prepare('SELECT * FROM items WHERE app_id=? ORDER BY seq'),
    insertAttachment: db.prepare(
      'INSERT INTO attachments(id,item_id,name,serial_no,quantity,weight_kg,created_at) VALUES(?,?,?,?,?,?,?)',
    ),
    attachmentsByItem: db.prepare('SELECT * FROM attachments WHERE item_id=? ORDER BY rowid'),
    insertPart: db.prepare(
      `INSERT INTO parts(id,item_id,serial_no,name,initial_qty,settled_qty,consumed_qty,weight_kg,is_root,state,origin_event_id,created_at)
       VALUES(?,?,?,?,?,0,0,?,?,?,?,?)`,
    ),
    part: db.prepare('SELECT * FROM parts WHERE id=?'),
    partsByItem: db.prepare('SELECT * FROM parts WHERE item_id=? ORDER BY rowid'),
    activePartsByItem: db.prepare("SELECT * FROM parts WHERE item_id=? AND state='active' ORDER BY rowid"),
    bumpPart: db.prepare(
      'UPDATE parts SET settled_qty=settled_qty+?, consumed_qty=consumed_qty+? WHERE id=?',
    ),
    setPartState: db.prepare('UPDATE parts SET state=? WHERE id=?'),
    nextEventSeq: db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM genealogy_events WHERE item_id=?'),
    insertEvent: db.prepare(
      'INSERT INTO genealogy_events(id,item_id,seq,action,actor,detail_json,mapping_note,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ),
    eventsByItem: db.prepare('SELECT * FROM genealogy_events WHERE item_id=? ORDER BY seq'),
    linksByEvent: db.prepare('SELECT * FROM genealogy_links WHERE event_id=?'),
    insertLink: db.prepare(
      'INSERT INTO genealogy_links(id,event_id,parent_part_id,child_part_id,relation,note) VALUES(?,?,?,?,?,?)',
    ),
    insertBatch: db.prepare(
      `INSERT INTO return_batches(id,item_id,status,state_version_base,created_at,confirmed_at)
       VALUES(?,?,?,?,?,NULL)`,
    ),
    batch: db.prepare('SELECT * FROM return_batches WHERE id=?'),
    batchesByItem: db.prepare('SELECT * FROM return_batches WHERE item_id=? ORDER BY created_at'),
    setBatchStatus: db.prepare('UPDATE return_batches SET status=?, confirmed_at=? WHERE id=?'),
    // 复运确认成功时 CAS 推进版本，使并发的旧批次确认与待生效方案互斥
    casConfirmVersion: db.prepare(
      'UPDATE items SET state_version=state_version+1 WHERE id=? AND state_version=?',
    ),
    insertPackage: db.prepare(
      'INSERT INTO packages(id,batch_id,pack_no,expected_weight_kg,actual_weight_kg) VALUES(?,?,?,?,?)',
    ),
    packagesByBatch: db.prepare('SELECT * FROM packages WHERE batch_id=? ORDER BY pack_no'),
    packageByNo: db.prepare('SELECT * FROM packages WHERE pack_no=?'),
    setPackageWeight: db.prepare('UPDATE packages SET actual_weight_kg=? WHERE id=?'),
    insertLine: db.prepare(
      `INSERT INTO return_lines(id,package_id,part_id,expected_serial_no,expected_weight_kg,qty,
        actual_serial_no,actual_weight_kg,settled) VALUES(?,?,?,?,?,?,?,?,0)`,
    ),
    line: db.prepare('SELECT * FROM return_lines WHERE id=?'),
    linesByPackage: db.prepare('SELECT * FROM return_lines WHERE package_id=? ORDER BY rowid'),
    linesByBatch: db.prepare(
      `SELECT rl.* FROM return_lines rl JOIN packages p ON p.id=rl.package_id
       WHERE p.batch_id=? ORDER BY p.pack_no, rl.rowid`,
    ),
    markLineSettled: db.prepare('UPDATE return_lines SET settled=1 WHERE id=?'),
    setLineActual: db.prepare(
      'UPDATE return_lines SET actual_serial_no=?, actual_weight_kg=? WHERE id=?',
    ),
    receipt: db.prepare('SELECT * FROM carrier_receipts WHERE receipt_no=?'),
    insertReceipt: db.prepare(
      'INSERT INTO carrier_receipts(receipt_no,batch_id,payload_json,received_at,linked_at) VALUES(?,?,?,?,?)',
    ),
    linkReceipt: db.prepare(
      'UPDATE carrier_receipts SET batch_id=?, linked_at=? WHERE receipt_no=? AND batch_id IS NULL',
    ),
    receiptsByBatch: db.prepare('SELECT * FROM carrier_receipts WHERE batch_id=?'),
    insertReview: db.prepare(
      `INSERT INTO manual_reviews(id,batch_id,item_id,type,expected_json,actual_json,status,resolution_note,created_at,resolved_at)
       VALUES(?,?,?,?,?,?,'open',NULL,?,NULL)`,
    ),
    reviewsByBatch: db.prepare('SELECT * FROM manual_reviews WHERE batch_id=? ORDER BY rowid'),
    openReviewsByItem: db.prepare("SELECT COUNT(*) AS c FROM manual_reviews WHERE item_id=? AND status='open'"),
    review: db.prepare('SELECT * FROM manual_reviews WHERE id=?'),
    resolveReview: db.prepare(
      "UPDATE manual_reviews SET status=?, resolution_note=?, resolved_at=? WHERE id=? AND status='open'",
    ),
    insertApproval: db.prepare(
      `INSERT INTO disposition_approvals(id,item_id,type,status,reason,payload_json,created_at,decided_at)
       VALUES(?,?,?, 'pending', ?,?, ?,NULL)`,
    ),
    approval: db.prepare('SELECT * FROM disposition_approvals WHERE id=?'),
    approvalsByItem: db.prepare('SELECT * FROM disposition_approvals WHERE item_id=? ORDER BY created_at'),
    decideApproval: db.prepare(
      "UPDATE disposition_approvals SET status=?, decided_at=? WHERE id=? AND status='pending'",
    ),
    insertDeadlineHistory: db.prepare(
      'INSERT INTO deadline_history(id,item_id,change_type,approval_id,old_deadline,new_deadline,reason,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ),
    deadlineHistoryByItem: db.prepare('SELECT * FROM deadline_history WHERE item_id=? ORDER BY created_at'),
    setDeadline: db.prepare('UPDATE items SET repair_deadline=? WHERE id=?'),
    stopDeadline: db.prepare('UPDATE items SET deadline_stopped_at=? WHERE id=? AND deadline_stopped_at IS NULL'),
    closeState: db.prepare("UPDATE items SET state='obligation_closed' WHERE id=? AND state='open'"),
    insertLedger: db.prepare(
      'INSERT INTO disposition_ledger(id,item_id,part_id,qty,source,ref_id,created_at) VALUES(?,?,?,?,?,?,?)',
    ),
    ledgerByItem: db.prepare('SELECT * FROM disposition_ledger WHERE item_id=? ORDER BY created_at, rowid'),
    insertPlan: db.prepare(
      `INSERT INTO plan_versions(id,item_id,version,base_state_version,content_json,status,created_at,effective_at)
       VALUES(?,?,?,?,?,'proposed',?,NULL)`,
    ),
    plan: db.prepare('SELECT * FROM plan_versions WHERE id=?'),
    plansByItem: db.prepare('SELECT * FROM plan_versions WHERE item_id=? ORDER BY version'),
    bumpStateVersion: db.prepare('UPDATE items SET state_version=state_version+1 WHERE id=? AND state_version=?'),
    bumpPlanVersion: db.prepare(
      'UPDATE items SET plan_version=plan_version+1, state_version=state_version+1, effective_plan_id=? WHERE id=? AND state_version=?',
    ),
    supersedePlan: db.prepare("UPDATE plan_versions SET status='superseded' WHERE item_id=? AND status='effective'"),
    effectivePlanSet: db.prepare(
      "UPDATE plan_versions SET status='effective', effective_at=? WHERE id=? AND status='proposed'",
    ),
    insertScan: db.prepare(
      `INSERT INTO scan_runs(run_id,as_of,page_size,cursor_pos,status,marked_count,created_at,updated_at)
       VALUES(?,?,?,0,'running',0,?,?)`,
    ),
    scan: db.prepare('SELECT * FROM scan_runs WHERE run_id=?'),
    snapshotCandidates: db.prepare(
      `INSERT INTO scan_candidates(run_id,item_id)
       SELECT ?, id FROM items
       WHERE state='open' AND deadline_stopped_at IS NULL AND repair_deadline<=?
       ORDER BY repair_deadline, id`,
    ),
    countCandidates: db.prepare('SELECT COUNT(*) AS c FROM scan_candidates WHERE run_id=?'),
    candidatePage: db.prepare(
      'SELECT sc.rowid_delta AS pos, sc.item_id FROM scan_candidates sc WHERE sc.run_id=? AND sc.rowid_delta>? ORDER BY sc.rowid_delta LIMIT ?',
    ),
    advanceScan: db.prepare(
      'UPDATE scan_runs SET cursor_pos=?, marked_count=?, status=?, updated_at=? WHERE run_id=?',
    ),
    insertListing: db.prepare(
      'INSERT OR IGNORE INTO due_listings(run_id,item_id,marked_at) VALUES(?,?,?)',
    ),
    listingsByRun: db.prepare(
      `SELECT dl.*, i.serial_no, i.repair_deadline, i.app_id FROM due_listings dl
       JOIN items i ON i.id=dl.item_id WHERE dl.run_id=? ORDER BY dl.marked_at, dl.item_id`,
    ),
  };

  // ---------- 工具 ----------

  const getItem = (itemId) => {
    const item = q.item.get(itemId);
    if (!item) throw new HttpError(404, `设备不存在: ${itemId}`);
    return item;
  };

  const getBatch = (batchId) => {
    const batch = q.batch.get(batchId);
    if (!batch) throw new HttpError(404, `复运批次不存在: ${batchId}`);
    return batch;
  };

  const availableOf = (part) => part.initial_qty - part.consumed_qty - part.settled_qty;

  // 原义务剩余待处置数量（extra 增件不占原义务）
  const obligationOfItem = (itemId) => {
    const parts = q.partsByItem.all(itemId);
    let remaining = 0;
    for (const p of parts) {
      if (p.state === 'extra') continue;
      remaining += Math.max(0, availableOf(p));
    }
    return { parts, remaining };
  };

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const settlePart = (itemId, partId, qty, source, refId, ts) => {
    const p = q.part.get(partId);
    const avail = availableOf(p);
    if (qty > avail + 1e-9) {
      throw new HttpError(422,
        `已核销数量与待处置数量重叠：部件「${p.name}」本次 ${qty}，剩余可核销 ${avail.toFixed(4)}`);
    }
    q.bumpPart.run(qty, 0, partId);
    q.insertLedger.run(id('led'), itemId, partId, qty, source, refId, ts);
    return p;
  };

  // ---------- 出境申请 ----------

  // 申报：固定原报关单、序列号、附件清单、申报状态、维修期限、允许承修方
  function createApplication(input) {
    assert400(input && typeof input === 'object', '请求体必须为对象');
    const {
      customs_declaration_no: declarationNo,
      applicant,
      allowed_repairers: repairers = [],
      items: rawItems = [],
    } = input;
    assert400(typeof declarationNo === 'string' && declarationNo.trim(), 'customs_declaration_no 必填');
    assert400(Array.isArray(repairers) && repairers.length > 0, 'allowed_repairers 至少一个承修方');
    assert400(Array.isArray(rawItems) && rawItems.length > 0, 'items 至少一台设备');

    return tx(() => {
      if (q.appByDecl.get(declarationNo)) {
        throw new HttpError(409, `原报关单已申报: ${declarationNo}`);
      }
      const appId = id('app');
      const ts = now();
      q.insertApp.run(appId, declarationNo, 'declared', applicant || null,
        JSON.stringify(repairers), ts, ts);

      rawItems.forEach((raw, idx) => {
        assert400(raw && typeof raw.serial_no === 'string' && raw.serial_no.trim(),
          `items[${idx}].serial_no 必填`);
        const { repair_deadline: deadline } = raw;
        assert400(typeof deadline === 'string' && !Number.isNaN(Date.parse(deadline)),
          `items[${idx}].repair_deadline 必须为 ISO 时间`);
        const quantity = raw.quantity ?? 1;
        assert400(Number.isFinite(quantity) && quantity > 0, `items[${idx}].quantity 非法`);
        const itemId = id('item');
        q.insertItem.run({
          id: itemId,
          app_id: appId,
          seq: idx + 1,
          serial_no: raw.serial_no,
          model: raw.model ?? null,
          description: raw.description ?? null,
          quantity,
          unit: raw.unit ?? '台',
          weight_kg: raw.weight_kg ?? null,
          repair_deadline: deadline,
          created_at: ts,
        });
        // 根部件 = 原机（可核销义务主体）
        q.insertPart.run(id('part'), itemId, raw.serial_no, raw.description || raw.model || '原设备',
          quantity, raw.weight_kg ?? null, 1, 'active', null, ts);
        for (const att of raw.attachments || []) {
          assert400(att && typeof att.name === 'string' && att.name.trim(),
            `items[${idx}] 附件缺少 name`);
          const aqty = att.quantity ?? 1;
          q.insertAttachment.run(id('att'), itemId, att.name, att.serial_no ?? null,
            aqty, att.weight_kg ?? null, ts);
          // 附件也是独立可核销根部件
          q.insertPart.run(id('part'), itemId, att.serial_no ?? null, att.name,
            aqty, att.weight_kg ?? null, 1, 'active', null, ts);
        }
      });
      return getApplication(appId);
    });
  }

  function decideApplication(appId, decision) {
    return tx(() => {
      const app = q.app.get(appId);
      if (!app) throw new HttpError(404, `申请不存在: ${appId}`);
      if (app.status !== 'declared') throw new HttpError(409, `申请当前状态 ${app.status} 不可审批`);
      if (!['approved', 'rejected'].includes(decision)) throw new HttpError(400, 'decision 非法');
      q.updateAppStatus.run(decision, now(), appId);
      return getApplication(appId);
    });
  }

  function getApplication(appId) {
    const app = q.app.get(appId);
    if (!app) throw new HttpError(404, `申请不存在: ${appId}`);
    return {
      ...app,
      allowed_repairers: JSON.parse(app.allowed_repairers_json),
      items: q.itemsByApp.all(appId).map((item) => ({
        ...item,
        attachments: q.attachmentsByItem.all(item.id),
        parts: q.partsByItem.all(item.id).map((p) => ({ ...p, available_qty: availableOf(p) })),
      })),
    };
  }

  // ---------- 维修谱系事件 ----------

  const checkRepairer = (item, actor) => {
    const app = q.app.get(item.app_id);
    if (app.status !== 'approved') throw new HttpError(409, '申请尚未批准，不得开始维修');
    const allowed = JSON.parse(app.allowed_repairers_json);
    if (actor && !allowed.includes(actor)) throw new HttpError(403, `承修方不在允许名单: ${actor}`);
  };

  // 追加检测/拆解/替换/重新装配事件（只追加，谱系不可改写）
  function appendGenealogyEvent(itemId, body) {
    assert400(body && typeof body === 'object', '请求体必须为对象');
    const { action, actor, detail, note } = body;
    if (!['detect', 'disassemble', 'replace', 'reassemble'].includes(action)) {
      throw new HttpError(400, 'action 必须为 detect/disassemble/replace/reassemble');
    }
    return tx(() => {
      const item = getItem(itemId);
      checkRepairer(item, actor);
      if (item.state !== 'open') throw new HttpError(409, '设备义务已关闭，不可再追加维修事件');
      const ts = now();
      const seq = q.nextEventSeq.get(itemId).seq;
      const eventId = id('evt');
      q.insertEvent.run(eventId, itemId, seq, action, actor ?? null,
        JSON.stringify(detail ?? {}), note ?? null, ts);

      const mappings = body.mappings || [];
      if (action === 'replace') applyReplace(itemId, eventId, mappings, ts);
      else if (action === 'disassemble') applyDisassemble(itemId, eventId, mappings, ts);
      else if (action === 'reassemble') applyReassemble(itemId, eventId, mappings, ts);
      // detect 仅记录检测结论，不改拓扑

      return getGenealogy(itemId);
    });
  }

  const getPartChecked = (partId, itemId) => {
    const p = q.part.get(partId);
    if (!p || p.item_id !== itemId) throw new HttpError(400, `部件不属于该设备: ${partId}`);
    return p;
  };

  // 替换：必须显式声明一对一或组合对应
  //  - one_to_one: 一个原件 -> 一个新件，数量必须相等
  //  - combination: 多个原件 -> 一个新件（合并替换）
  function applyReplace(itemId, eventId, mappings, ts) {
    assert400(Array.isArray(mappings) && mappings.length > 0,
      'replace 必须提供 mappings，说明替换件与原件的一对一或组合对应');
    const used = new Map(); // 本事件内每个原件的累计消耗
    const produced = [];
    mappings.forEach((m, i) => {
      if (!['one_to_one', 'combination'].includes(m.relation)) {
        throw new HttpError(400, `mappings[${i}].relation 必须为 one_to_one 或 combination`);
      }
      const inputs = m.from_part_ids;
      const output = m.to_part;
      assert400(Array.isArray(inputs) && inputs.length > 0, `mappings[${i}].from_part_ids 必填`);
      assert400(output && typeof output.name === 'string', `mappings[${i}].to_part.name 必填`);
      if (m.relation === 'one_to_one') assert400(inputs.length === 1, 'one_to_one 必须恰好一个原件');

      let inputQty = 0;
      inputs.forEach((pid) => {
        const p = getPartChecked(pid, itemId);
        if (p.state === 'extra') throw new HttpError(400, `增件不参与替换对应: ${pid}`);
        if (p.state !== 'active') throw new HttpError(409, `原件已不可用: ${pid}`);
        const useQty = m.from_qty?.[pid]
          ?? (m.relation === 'one_to_one' ? availableOf(p) : availableOf(p));
        assert400(useQty > 0 && useQty <= availableOf(p) + 1e-9, `原件可用数量不足: ${pid}`);
        used.set(pid, (used.get(pid) || 0) + useQty);
        assert400(used.get(pid) <= availableOf(p) + 1e-9, `原件在本次替换中被重复消耗: ${pid}`);
        inputQty += useQty;
      });

      const outQty = output.quantity ?? inputQty;
      assert400(Number.isFinite(outQty) && outQty > 0, `mappings[${i}] 新件数量非法`);
      if (m.relation === 'one_to_one') {
        assert400(Math.abs(outQty - inputQty) < 1e-9, '一对一替换的新件数量必须与原件相等');
      }
      const outId = id('part');
      q.insertPart.run(outId, itemId, output.serial_no ?? null, output.name,
        outQty, output.weight_kg ?? null, 0, 'active', eventId, ts);
      produced.push({ outId, inputs, relation: m.relation, note: m.note ?? null });
    });

    for (const [pid, useQty] of used) {
      q.bumpPart.run(0, useQty, pid);
      if (availableOf(q.part.get(pid)) <= 1e-9) q.setPartState.run('inactive', pid);
    }
    for (const o of produced) {
      for (const pid of o.inputs) {
        q.insertLink.run(id('link'), eventId, pid, o.outId, o.relation, o.note);
      }
    }
  }

  // 拆解：一个原件 -> 多个子件（split），子件数量之和必须等于拆解数量
  function applyDisassemble(itemId, eventId, mappings, ts) {
    assert400(mappings.length === 1 && mappings[0].relation === 'split',
      'disassemble 需要一条 relation=split 的 mapping');
    const mapping = mappings[0];
    const source = getPartChecked(mapping.from_part_id, itemId);
    if (source.state !== 'active') throw new HttpError(409, `部件已不可拆解: ${source.id}`);
    const children = mapping.to_parts;
    assert400(Array.isArray(children) && children.length > 0, 'split 需要 to_parts');
    const useQty = mapping.quantity ?? availableOf(source);
    assert400(useQty > 0 && useQty <= availableOf(source) + 1e-9, '拆解数量超出可用数量');
    const childQty = sum(children.map((c) => c.quantity ?? 0));
    assert400(Math.abs(childQty - useQty) < 1e-9,
      `拆出子件数量之和(${childQty})必须等于拆解数量(${useQty})`);
    q.bumpPart.run(0, useQty, source.id);
    if (availableOf(q.part.get(source.id)) <= 1e-9) q.setPartState.run('inactive', source.id);
    children.forEach((c) => {
      assert400(c && typeof c.name === 'string', '拆出件缺少 name');
      const cid = id('part');
      q.insertPart.run(cid, itemId, c.serial_no ?? null, c.name,
        c.quantity, c.weight_kg ?? null, 0, 'active', eventId, ts);
      q.insertLink.run(id('link'), eventId, source.id, cid, 'split', c.note ?? null);
    });
  }

  // 重新装配：多个子件 -> 一个组件（combination），组件数量 = 装配件数量之和
  function applyReassemble(itemId, eventId, mappings, ts) {
    assert400(mappings.length === 1 && mappings[0].relation === 'combination',
      'reassemble 需要一条 relation=combination 的 mapping');
    const mapping = mappings[0];
    const inputs = mapping.from_part_ids;
    const output = mapping.to_part;
    assert400(Array.isArray(inputs) && inputs.length > 0, 'combination 需要 from_part_ids');
    assert400(output && typeof output.name === 'string', 'combination 缺少 to_part.name');
    let totalIn = 0;
    const seen = new Set();
    inputs.forEach((pid) => {
      if (seen.has(pid)) throw new HttpError(400, `装配件重复: ${pid}`);
      seen.add(pid);
      const p = getPartChecked(pid, itemId);
      if (p.state !== 'active') throw new HttpError(409, `部件已不可用于装配: ${pid}`);
      const useQty = mapping.from_qty?.[pid] ?? availableOf(p);
      assert400(useQty > 0 && useQty <= availableOf(p) + 1e-9, `装配件可用数量不足: ${pid}`);
      totalIn += useQty;
      q.bumpPart.run(0, useQty, pid);
      if (availableOf(q.part.get(pid)) <= 1e-9) q.setPartState.run('inactive', pid);
    });
    const outQty = output.quantity ?? totalIn;
    assert400(Math.abs(outQty - totalIn) < 1e-9,
      `重组件数量(${outQty})必须等于装配件数量之和(${totalIn})`);
    const outId = id('part');
    q.insertPart.run(outId, itemId, output.serial_no ?? null, output.name,
      outQty, output.weight_kg ?? null, 0, 'active', eventId, ts);
    inputs.forEach((pid) => {
      q.insertLink.run(id('link'), eventId, pid, outId, 'combination', mapping.note ?? null);
    });
  }

  function getGenealogy(itemId) {
    getItem(itemId);
    const parts = q.partsByItem.all(itemId).map((p) => ({ ...p, available_qty: availableOf(p) }));
    const events = q.eventsByItem.all(itemId).map((e) => ({
      ...e,
      detail: JSON.parse(e.detail_json),
      links: q.linksByEvent.all(e.id),
    }));
    return { parts, events };
  }

  // ---------- 复运批次与包装 ----------

  // 登记分批返运计划；清单为申报口径，同时锁定当前方案版本基线
  function planReturnBatch(itemId, body) {
    assert400(body && typeof body === 'object', '请求体必须为对象');
    const packages = body.packages;
    assert400(Array.isArray(packages) && packages.length > 0, 'packages 至少一个包装');
    return tx(() => {
      const item = getItem(itemId);
      if (item.state !== 'open') throw new HttpError(409, '设备义务已关闭');
      const batchId = id('batch');
      q.insertBatch.run(batchId, itemId, 'planned', item.state_version, now());
      packages.forEach((pkg, pi) => {
        assert400(pkg && typeof pkg.pack_no === 'string' && pkg.pack_no.trim(),
          `packages[${pi}].pack_no 必填`);
        const pkgId = id('pkg');
        q.insertPackage.run(pkgId, batchId, pkg.pack_no, pkg.expected_weight_kg ?? null, null);
        const lines = pkg.lines || [];
        assert400(lines.length > 0, `包装 ${pkg.pack_no} 清单不能为空`);
        lines.forEach((line, li) => {
          if (line.part_id) {
            const p = getPartChecked(line.part_id, itemId);
            if (p.state === 'extra') throw new HttpError(400, `增件须走人工比对，不可直接列入核销: ${p.id}`);
          }
          const lineQty = line.qty ?? 1;
          assert400(Number.isFinite(lineQty) && lineQty > 0, `packages[${pi}].lines[${li}].qty 非法`);
          q.insertLine.run(id('line'), pkgId, line.part_id ?? null,
            line.expected_serial_no ?? null, line.expected_weight_kg ?? null, lineQty,
            line.actual_serial_no ?? null, line.actual_weight_kg ?? null);
        });
      });
      return getBatchDetail(batchId);
    });
  }

  function insertReview(batch, item, type, expected, actual, ts) {
    const reviewId = id('rev');
    q.insertReview.run(reviewId, batch.id, item.id, type,
      JSON.stringify(expected ?? {}), JSON.stringify(actual ?? {}), ts);
    return q.review.get(reviewId);
  }

  // 复运确认：逐行实物比对。差异进人工且绝不靠最后清单覆盖；正常行即时核销。
  function confirmReturnBatch(batchId, body = {}) {
    return tx(() => {
      const batch = getBatch(batchId);
      if (batch.status === 'confirmed') throw new HttpError(409, '批次已确认，不能重复确认');
      if (batch.status === 'void') throw new HttpError(409, '批次已作废');
      if (batch.status === 'pending_manual') {
        throw new HttpError(409, '批次存在待裁决的人工比对，不能用新清单覆盖，请先处理比对单');
      }
      const item = getItem(batch.item_id);

      // 乐观并发：批次建立后方案若变更生效（state_version 前进），本次确认整体失效
      if (item.state_version !== batch.state_version_base) {
        throw new HttpError(409,
          '复运确认与维修方案变更并发：方案已有新版本生效，请按当前谱系重建批次清单后再确认');
      }

      const ts = now();
      const reviews = [];
      const actualsByLine = new Map((body.actuals || []).map((a) => [a.line_id, a]));
      const pkgActualByNo = new Map((body.package_actuals || []).map((a) => [a.pack_no, a]));

      for (const pkg of q.packagesByBatch.all(batchId)) {
        const pkgActual = pkgActualByNo.get(pkg.pack_no) || {};
        const actualPkgWeight = pkgActual.actual_weight_kg ?? null;
        q.setPackageWeight.run(actualPkgWeight, pkg.id);

        // 整箱重量偏差
        if (actualPkgWeight != null && pkg.expected_weight_kg != null && pkg.expected_weight_kg > 0) {
          const deviation = Math.abs(actualPkgWeight - pkg.expected_weight_kg) / pkg.expected_weight_kg;
          if (deviation > WEIGHT_TOL) {
            reviews.push(insertReview(batch, item, 'weight_mismatch',
              { pack_no: pkg.pack_no, expected_weight_kg: pkg.expected_weight_kg },
              { pack_no: pkg.pack_no, actual_weight_kg: actualPkgWeight, deviation }, ts));
          }
        }

        for (const line of q.linesByPackage.all(pkg.id)) {
          const actual = actualsByLine.get(line.id) || {};
          const present = actual.present !== undefined ? actual.present : true;
          const actualSerial = actual.actual_serial_no ?? line.expected_serial_no;
          const actualWeight = actual.actual_weight_kg ?? line.expected_weight_kg;
          q.setLineActual.run(actualSerial ?? null, actualWeight ?? null, line.id);

          if (!present) {
            // 少件：不核销，转人工；后续只能凭独立处置审批了结
            reviews.push(insertReview(batch, item, 'missing_part',
              { line_id: line.id, pack_no: pkg.pack_no, expected_serial_no: line.expected_serial_no, qty: line.qty },
              { line_id: line.id, present: false }, ts));
            continue;
          }

          if (line.expected_serial_no != null && actualSerial != null
              && String(actualSerial) !== String(line.expected_serial_no)) {
            // 序列号变化：存疑不核销
            reviews.push(insertReview(batch, item, 'serial_changed',
              { line_id: line.id, pack_no: pkg.pack_no, expected_serial_no: line.expected_serial_no },
              { line_id: line.id, actual_serial_no: actualSerial }, ts));
            continue;
          }

          if (actualWeight != null && line.expected_weight_kg != null && line.expected_weight_kg > 0) {
            const deviation = Math.abs(actualWeight - line.expected_weight_kg) / line.expected_weight_kg;
            if (deviation > WEIGHT_TOL) {
              reviews.push(insertReview(batch, item, 'weight_mismatch',
                { line_id: line.id, expected_weight_kg: line.expected_weight_kg },
                { line_id: line.id, actual_weight_kg: actualWeight, deviation }, ts));
              continue;
            }
          }

          if (line.part_id) {
            const part = q.part.get(line.part_id);
            if (part.state === 'extra') continue; // 增件不占原义务
            if (part.state !== 'active') throw new HttpError(409, `清单部件当前不可核销: ${part.id}`);
            // 即时核销：同一批次内多行、或与历史批次重叠都会在此被拒
            settlePart(item.id, part.id, line.qty, 'return', batch.id, ts);
            q.markLineSettled.run(line.id);
          }
        }

        // 增件：实物多出的未申报物，登记为 extra 并转人工，不冲减原义务
        for (const extra of pkgActual.extras || []) {
          const exId = id('part');
          q.insertPart.run(exId, item.id, extra.serial_no ?? null, extra.name || '未申报增件',
            extra.quantity ?? 1, extra.weight_kg ?? null, 0, 'extra', null, ts);
          q.insertLine.run(id('line'), pkg.id, exId, null, null, extra.quantity ?? 1,
            extra.serial_no ?? null, extra.weight_kg ?? null);
          reviews.push(insertReview(batch, item, 'extra_part',
            { pack_no: pkg.pack_no }, { extra }, ts));
        }
      }

      if (reviews.length > 0) {
        q.setBatchStatus.run('pending_manual', null, batchId);
      } else {
        q.setBatchStatus.run('confirmed', ts, batchId);
        maybeCloseItem(item.id);
      }
      // 本次实物确认已发生：推进版本，使并发的旧批次/待生效方案失败
      const bumped = q.casConfirmVersion.run(item.id, batch.state_version_base);
      if (bumped.changes === 0) throw new HttpError(409, '复运确认与方案变更并发，请重试');
      return getBatchDetail(batchId);
    });
  }

  // 人工裁决
  //  accepted: 序列号变化/重量偏差经人工确认后核销对应行；少件不核销（须独立审批）；增件保留 extra
  //  rejected: 维持未核销，设备剩余义务保留
  function resolveManualReview(reviewId, body = {}) {
    const { decision } = body;
    if (!['accepted', 'rejected'].includes(decision)) {
      throw new HttpError(400, 'decision 必须为 accepted/rejected');
    }
    return tx(() => {
      const review = q.review.get(reviewId);
      if (!review) throw new HttpError(404, `人工比对单不存在: ${reviewId}`);
      if (review.status !== 'open') throw new HttpError(409, '该比对已裁决');
      const batch = getBatch(review.batch_id);
      const item = getItem(review.item_id);
      const ts = now();
      const changed = q.resolveReview.run(decision, body.note ?? null, ts, reviewId);
      if (changed.changes === 0) throw new HttpError(409, '该比对已被并发裁决');

      if (decision === 'accepted') {
        if (review.type === 'missing_part' && body.write_off) {
          throw new HttpError(400, '少件不得直接核销，须先走报废/转售/正式进口独立审批');
        }
        if (review.type === 'serial_changed' || review.type === 'weight_mismatch') {
          const expected = JSON.parse(review.expected_json);
          const line = expected.line_id ? q.line.get(expected.line_id) : null;
          if (line && line.part_id && !line.settled) {
            const part = q.part.get(line.part_id);
            if (part.state === 'active') {
              settlePart(item.id, part.id, line.qty, 'return', batch.id, ts);
              q.markLineSettled.run(line.id);
            }
          }
        }
        // extra_part 接受：部件保持 extra，仅表示关务认可登记
      }

      const openCount = q.reviewsByBatch.all(batch.id).filter((r) => r.status === 'open').length;
      if (openCount === 0 && batch.status === 'pending_manual') {
        // 被退回的差异对应数量仍未核销，设备义务保持 open
        q.setBatchStatus.run('confirmed', ts, batch.id);
        maybeCloseItem(item.id);
      }
      return { review: q.review.get(reviewId), batch: getBatchDetail(batch.id) };
    });
  }

  function getBatchDetail(batchId) {
    const batch = getBatch(batchId);
    return {
      ...batch,
      packages: q.packagesByBatch.all(batchId).map((pkg) => ({
        ...pkg,
        lines: q.linesByPackage.all(pkg.id),
      })),
      reviews: q.reviewsByBatch.all(batchId).map((r) => ({
        ...r,
        expected: JSON.parse(r.expected_json),
        actual: JSON.parse(r.actual_json),
      })),
    };
  }

  // ---------- 离线承运回执：按自身流水去重 ----------

  function ingestCarrierReceipt(body) {
    assert400(body && typeof body.receipt_no === 'string' && body.receipt_no.trim(), 'receipt_no 必填');
    return tx(() => {
      const ts = now();
      const existing = q.receipt.get(body.receipt_no);
      if (existing) return { duplicate: true, receipt: existing };
      const batchId = body.batch_id ?? null;
      if (batchId) getBatch(batchId);
      q.insertReceipt.run(body.receipt_no, batchId, JSON.stringify(body.payload ?? {}), ts,
        batchId ? ts : null);
      return { duplicate: false, receipt: q.receipt.get(body.receipt_no) };
    });
  }

  function linkReceiptToBatch(receiptNo, batchId) {
    return tx(() => {
      const receipt = q.receipt.get(receiptNo);
      if (!receipt) throw new HttpError(404, `回执不存在: ${receiptNo}`);
      getBatch(batchId);
      if (receipt.batch_id && receipt.batch_id !== batchId) {
        throw new HttpError(409, `回执已绑定批次 ${receipt.batch_id}`);
      }
      if (!receipt.batch_id) {
        const changed = q.linkReceipt.run(batchId, now(), receiptNo);
        if (changed.changes === 0) throw new HttpError(409, '回执绑定失败');
      }
      return q.receipt.get(receiptNo);
    });
  }

  // ---------- 独立处置审批：延期 / 转售 / 报废 / 正式进口 ----------

  function submitDisposition(itemId, body) {
    assert400(body && typeof body === 'object', '请求体必须为对象');
    const { type } = body;
    if (!['extension', 'resale', 'scrap', 'formal_import'].includes(type)) {
      throw new HttpError(400, 'type 必须为 extension/resale/scrap/formal_import');
    }
    return tx(() => {
      const item = getItem(itemId);
      if (item.state !== 'open') throw new HttpError(409, '设备义务已关闭');
      // 转售/报废/正式进口要按数量核销：人工比对未澄清前不得提交
      if (type !== 'extension' && q.openReviewsByItem.get(itemId).c > 0) {
        throw new HttpError(409, '存在未裁决的人工比对，数量未澄清前不得申请转售/报废/正式进口');
      }
      const approvalId = id('appr');
      q.insertApproval.run(approvalId, itemId, type, body.reason ?? null,
        JSON.stringify(body.payload ?? {}), now());
      return q.approval.get(approvalId);
    });
  }

  function decideDisposition(approvalId, body = {}) {
    const { decision } = body;
    if (!['approved', 'rejected'].includes(decision)) throw new HttpError(400, 'decision 非法');
    return tx(() => {
      const approval = q.approval.get(approvalId);
      if (!approval) throw new HttpError(404, `审批不存在: ${approvalId}`);
      if (approval.status !== 'pending') throw new HttpError(409, '审批已决定');
      const item = getItem(approval.item_id);
      const ts = now();
      const changed = q.decideApproval.run(decision, ts, approvalId);
      if (changed.changes === 0) throw new HttpError(409, '审批被并发处理');

      if (decision === 'approved') {
        const payload = JSON.parse(approval.payload_json || '{}');
        if (approval.type === 'extension') {
          // 延期：原期限延续，完整保留轨迹；期限已停止（转入处置）不可再延期
          if (item.deadline_stopped_at != null) {
            throw new HttpError(409, '期限已随转售/报废/正式进口停止，不能再延期');
          }
          assert400(typeof payload.new_deadline === 'string'
            && !Number.isNaN(Date.parse(payload.new_deadline)), 'extension 需要 payload.new_deadline');
          assert400(Date.parse(payload.new_deadline) > Date.parse(item.repair_deadline),
            '新期限必须晚于当前期限');
          q.setDeadline.run(payload.new_deadline, item.id);
          q.insertDeadlineHistory.run(id('dlh'), item.id, 'extended', approvalId,
            item.repair_deadline, payload.new_deadline, approval.reason, ts);
        } else {
          // 转售 / 报废 / 正式进口：按数量核销，原期限停止
          if (q.openReviewsByItem.get(item.id).c > 0) {
            throw new HttpError(409, '存在未裁决的人工比对，不能在数量未澄清前处置');
          }
          const { remaining } = obligationOfItem(item.id);
          const qty = payload.quantity ?? remaining;
          assert400(Number.isFinite(qty) && qty > 0, '处置数量非法');
          if (qty > remaining + 1e-9) {
            throw new HttpError(422, `处置数量 ${qty} 超过剩余待处置 ${remaining}`);
          }
          const source = { resale: 'resale', scrap: 'scrap', formal_import: 'formal_import' }[approval.type];
          let left = qty;
          for (const p of q.activePartsByItem.all(item.id)) {
            if (left <= 1e-9) break;
            const avail = availableOf(p);
            if (avail <= 1e-9) continue;
            const take = Math.min(avail, left);
            settlePart(item.id, p.id, take, source, approvalId, ts);
            left -= take;
          }
          if (left > 1e-9) throw new HttpError(422, '可核销部件数量不足以覆盖本次处置');
          q.stopDeadline.run(ts, item.id);
          q.insertDeadlineHistory.run(id('dlh'), item.id, 'stopped', approvalId,
            item.repair_deadline, null, approval.reason, ts);
          maybeCloseItem(item.id);
        }
      }
      return { approval: q.approval.get(approvalId), item: q.item.get(item.id) };
    });
  }

  // ---------- 维修方案版本：与复运确认互斥 ----------

  function proposePlan(itemId, body) {
    return tx(() => {
      const item = getItem(itemId);
      if (item.state !== 'open') throw new HttpError(409, '设备义务已关闭');
      // 版本号按已提案数递增，保证并发提案也不撞号；是否生效由 effective 决定
      const version = (q.plansByItem.all(itemId).reduce((m, p) => Math.max(m, p.version), 0)) + 1;
      const planId = id('plan');
      q.insertPlan.run(planId, itemId, version, item.state_version,
        JSON.stringify(body?.content ?? body ?? {}), now());
      return q.plan.get(planId);
    });
  }

  function effectivePlan(planId) {
    return tx(() => {
      const plan = q.plan.get(planId);
      if (!plan) throw new HttpError(404, '方案不存在');
      if (plan.status === 'effective') return plan;
      if (plan.status === 'superseded') throw new HttpError(409, '方案已被取代');
      const item = getItem(plan.item_id);
      // 数量尚有争议（未裁决人工比对）时不得变更方案
      if (q.openReviewsByItem.get(item.id).c > 0) {
        throw new HttpError(409, '存在未裁决的人工比对，维修方案暂不能变更');
      }
      // CAS：仅当方案提案后 state_version 未被复运确认/另一生效方案推进过时才能生效
      const changed = q.bumpPlanVersion.run(planId, item.id, plan.base_state_version);
      if (changed.changes === 0) {
        throw new HttpError(409, '方案生效与复运确认并发（或已被其他方案抢先生效）：该版本不能生效，请基于当前状态重试');
      }
      const ts = now();
      q.supersedePlan.run(item.id);
      q.effectivePlanSet.run(ts, planId);
      return q.plan.get(planId);
    });
  }

  // ---------- 义务关闭与状态 ----------

  function maybeCloseItem(itemId) {
    const { remaining } = obligationOfItem(itemId);
    const openReviews = q.openReviewsByItem.get(itemId).c;
    if (remaining <= 1e-9 && openReviews === 0) {
      q.closeState.run(itemId);
      const fresh = q.item.get(itemId);
      if (fresh.deadline_stopped_at == null) q.stopDeadline.run(now(), itemId);
    }
  }

  function itemStatus(itemId) {
    const item = getItem(itemId);
    const { parts, remaining } = obligationOfItem(itemId);
    return {
      ...item,
      parts: parts.map((p) => ({ ...p, available_qty: availableOf(p) })),
      remaining_qty: remaining,
      settled_qty: sum(parts.filter((p) => p.state !== 'extra').map((p) => p.settled_qty)),
      open_reviews: q.openReviewsByItem.get(itemId).c,
      ledger: q.ledgerByItem.all(itemId),
      deadline_history: q.deadlineHistoryByItem.all(itemId),
      approvals: q.approvalsByItem.all(itemId),
      plans: q.plansByItem.all(itemId),
      batches: q.batchesByItem.all(itemId),
    };
  }

  // ---------- 到期扫描：候选快照 + 稳定游标，断点续扫 ----------

  function runDueScan(options = {}) {
    const ts = now();
    return tx(() => {
      let run;
      if (options.run_id) {
        run = q.scan.get(options.run_id);
        if (!run) throw new HttpError(404, `扫描运行不存在: ${options.run_id}`);
      }
      if (!run) {
        const runId = id('scan');
        const asOf = options.as_of ?? ts;
        const pageSize = options.page_size ?? 500;
        q.insertScan.run(runId, asOf, pageSize, ts, ts);
        q.snapshotCandidates.run(runId, asOf); // 固化候选，迟到数据不影响本次扫描
        run = q.scan.get(runId);
      }
      if (run.status === 'completed') {
        return { run: q.scan.get(run.run_id), new_marked: 0, resumed: true, done: true,
          total_marked: q.listingsByRun.all(run.run_id).length,
          listings: q.listingsByRun.all(run.run_id) };
      }

      const rows = q.candidatePage.all(run.run_id, run.cursor_pos, run.page_size);
      let marked = 0;
      for (const row of rows) {
        marked += q.insertListing.run(run.run_id, row.item_id, ts).changes;
      }
      const cursor = rows.length ? rows[rows.length - 1].pos : run.cursor_pos;
      const done = rows.length < run.page_size;
      q.advanceScan.run(cursor, run.marked_count + marked, done ? 'completed' : 'running', ts, run.run_id);
      const fresh = q.scan.get(run.run_id);
      return {
        run: fresh,
        new_marked: marked,
        resumed: run.cursor_pos > 0,
        done,
        total_marked: fresh.marked_count,
        listings: done ? q.listingsByRun.all(run.run_id) : undefined,
      };
    });
  }

  // ---------- 全链追溯：任一返运包装 -> 原设备 / 维修动作 / 审批 / 剩余义务 ----------

  function tracePackage(packNo) {
    const pkg = q.packageByNo.get(packNo);
    if (!pkg) throw new HttpError(404, `包装不存在: ${packNo}`);
    const batch = getBatch(pkg.batch_id);
    const item = getItem(batch.item_id);
    const app = q.app.get(item.app_id);
    const lines = q.linesByPackage.all(pkg.id).map((line) => ({
      line,
      part: line.part_id ? q.part.get(line.part_id) : null,
      ancestry: line.part_id ? ancestryOf(line.part_id) : [],
    }));
    return {
      package: pkg,
      batch,
      item: {
        id: item.id,
        serial_no: item.serial_no,
        repair_deadline: item.repair_deadline,
        deadline_stopped_at: item.deadline_stopped_at,
        state: item.state,
        state_version: item.state_version,
      },
      application: {
        id: app.id,
        customs_declaration_no: app.customs_declaration_no,
        status: app.status,
        allowed_repairers: JSON.parse(app.allowed_repairers_json),
      },
      attachments: q.attachmentsByItem.all(item.id),
      parts_in_package: lines,
      events: q.eventsByItem.all(item.id).map((e) => ({
        seq: e.seq, action: e.action, actor: e.actor, at: e.created_at,
        detail: JSON.parse(e.detail_json), note: e.mapping_note,
        links: q.linksByEvent.all(e.id),
      })),
      approvals: q.approvalsByItem.all(item.id),
      deadline_history: q.deadlineHistoryByItem.all(item.id),
      ledger: q.ledgerByItem.all(item.id),
      remaining_obligation: obligationOfItem(item.id).remaining,
      receipts: q.receiptsByBatch.all(batch.id),
    };
  }

  // 沿谱系链回溯到原机/原附件根
  function ancestryOf(partId) {
    const chain = [];
    let current = partId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const part = q.part.get(current);
      if (!part) break;
      const links = db.prepare(
        `SELECT gl.*, ge.action, ge.seq AS event_seq FROM genealogy_links gl
         JOIN genealogy_events ge ON ge.id=gl.event_id
         WHERE gl.child_part_id=? ORDER BY ge.seq`,
      ).all(current);
      chain.push({
        part_id: part.id,
        name: part.name,
        serial_no: part.serial_no,
        is_root: !!part.is_root,
        state: part.state,
        initial_qty: part.initial_qty,
        settled_qty: part.settled_qty,
        available_qty: availableOf(part),
        via: links.map((l) => ({
          relation: l.relation, action: l.action, event_seq: l.event_seq, from_part_id: l.parent_part_id,
        })),
      });
      current = links[0]?.parent_part_id ?? null;
    }
    return chain;
  }

  return {
    createApplication,
    decideApplication,
    getApplication,
    appendGenealogyEvent,
    getGenealogy,
    planReturnBatch,
    confirmReturnBatch,
    resolveManualReview,
    getBatchDetail,
    ingestCarrierReceipt,
    linkReceiptToBatch,
    submitDisposition,
    decideDisposition,
    proposePlan,
    effectivePlan,
    itemStatus,
    runDueScan,
    tracePackage,
    HttpError,
  };
}

module.exports = { createRepairService, HttpError };
