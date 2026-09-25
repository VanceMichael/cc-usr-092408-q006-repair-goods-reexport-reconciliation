const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const MIGRATIONS = [
  // v1: 基线
  () => `
CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
`,
  // v2: 维修货物复运核销链
  () => `
-- 出境申请：固定原报关单、申报状态、维修期限与允许承修方
CREATE TABLE IF NOT EXISTS applications(
  id TEXT PRIMARY KEY,
  customs_declaration_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'declared'
    CHECK(status IN ('declared','approved','rejected','closed')),
  applicant TEXT,
  allowed_repairers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 设备行：序列号、数量、重量、维修期限与乐观版本
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id),
  seq INTEGER NOT NULL,
  serial_no TEXT NOT NULL,
  model TEXT,
  description TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit TEXT,
  weight_kg REAL,
  repair_deadline TEXT NOT NULL,
  deadline_stopped_at TEXT,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK(state IN ('open','obligation_closed')),
  state_version INTEGER NOT NULL DEFAULT 0,
  plan_version INTEGER NOT NULL DEFAULT 0,
  effective_plan_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, serial_no)
);

-- 附件清单（申请批准时固定）
CREATE TABLE IF NOT EXISTS attachments(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  serial_no TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  weight_kg REAL,
  created_at TEXT NOT NULL
);

-- 维修谱系事件：检测、拆解、替换、重新装配按序追加（先于 parts 建表以便外键引用）
CREATE TABLE IF NOT EXISTS genealogy_events(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  seq INTEGER NOT NULL,
  action TEXT NOT NULL
    CHECK(action IN ('detect','disassemble','replace','reassemble')),
  actor TEXT,
  detail_json TEXT,
  mapping_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_item ON genealogy_events(item_id);

-- 可核销部件（谱系节点）：root 为原机/原附件，其余由维修事件产生
CREATE TABLE IF NOT EXISTS parts(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  serial_no TEXT,
  name TEXT NOT NULL,
  initial_qty REAL NOT NULL,
  settled_qty REAL NOT NULL DEFAULT 0,
  consumed_qty REAL NOT NULL DEFAULT 0,
  weight_kg REAL,
  is_root INTEGER NOT NULL DEFAULT 0,
  -- active 可核销；inactive 已被替换/拆解/重组；extra 为人工登记的增件，不占原义务
  state TEXT NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','inactive','extra')),
  origin_event_id TEXT REFERENCES genealogy_events(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parts_item ON parts(item_id);

-- 谱系对应关系：一对一替换 / 组合（合并、重组）/ 拆分
CREATE TABLE IF NOT EXISTS genealogy_links(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES genealogy_events(id),
  parent_part_id TEXT REFERENCES parts(id),
  child_part_id TEXT REFERENCES parts(id),
  relation TEXT NOT NULL
    CHECK(relation IN ('one_to_one','combination','split')),
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_child ON genealogy_links(child_part_id);
CREATE INDEX IF NOT EXISTS idx_links_parent ON genealogy_links(parent_part_id);

-- 复运批次
CREATE TABLE IF NOT EXISTS return_batches(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  status TEXT NOT NULL
    CHECK(status IN ('planned','confirmed','pending_manual','void')),
  state_version_base INTEGER,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

-- 返运包装
CREATE TABLE IF NOT EXISTS packages(
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES return_batches(id),
  pack_no TEXT NOT NULL,
  expected_weight_kg REAL,
  actual_weight_kg REAL,
  UNIQUE(batch_id, pack_no)
);

-- 包装清单行：expected 为申报，actual 为复运确认时的实物
CREATE TABLE IF NOT EXISTS return_lines(
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  part_id TEXT REFERENCES parts(id),
  expected_serial_no TEXT,
  expected_weight_kg REAL,
  qty REAL NOT NULL DEFAULT 1,
  actual_serial_no TEXT,
  actual_weight_kg REAL,
  settled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lines_part ON return_lines(part_id);

-- 离线承运回执：按自身流水去重
CREATE TABLE IF NOT EXISTS carrier_receipts(
  receipt_no TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES return_batches(id),
  payload_json TEXT,
  received_at TEXT NOT NULL,
  linked_at TEXT
);

-- 人工比对：少件 / 增件 / 序列号变化 / 重量偏差
CREATE TABLE IF NOT EXISTS manual_reviews(
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES return_batches(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  type TEXT NOT NULL
    CHECK(type IN ('missing_part','extra_part','serial_changed','weight_mismatch')),
  expected_json TEXT,
  actual_json TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','accepted','rejected')),
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- 独立处置审批：延期 / 转售 / 报废 / 正式进口
CREATE TABLE IF NOT EXISTS disposition_approvals(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  type TEXT NOT NULL
    CHECK(type IN ('extension','resale','scrap','formal_import')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected')),
  reason TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

-- 期限历史：原期限如何停止或延续
CREATE TABLE IF NOT EXISTS deadline_history(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  change_type TEXT NOT NULL CHECK(change_type IN ('extended','stopped')),
  approval_id TEXT REFERENCES disposition_approvals(id),
  old_deadline TEXT,
  new_deadline TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- 核销流水：已核销数量的唯一权威来源，只追加，不被清单覆盖
CREATE TABLE IF NOT EXISTS disposition_ledger(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  part_id TEXT REFERENCES parts(id),
  qty REAL NOT NULL CHECK(qty > 0),
  source TEXT NOT NULL
    CHECK(source IN ('return','resale','scrap','formal_import','manual')),
  ref_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_item ON disposition_ledger(item_id);

-- 维修方案版本：同一设备至多一个生效版本
CREATE TABLE IF NOT EXISTS plan_versions(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  version INTEGER NOT NULL,
  base_state_version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('proposed','effective','superseded')),
  created_at TEXT NOT NULL,
  effective_at TEXT,
  UNIQUE(item_id, version)
);

-- 到期扫描运行：稳定游标，中断后继续
CREATE TABLE IF NOT EXISTS scan_runs(
  run_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  page_size INTEGER NOT NULL,
  cursor_pos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed')),
  marked_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 扫描候选快照：run 创建时固化，保证续扫按稳定顺序推进、迟到数据不打乱游标
CREATE TABLE IF NOT EXISTS scan_candidates(
  run_id TEXT NOT NULL REFERENCES scan_runs(run_id),
  item_id TEXT NOT NULL,
  rowid_delta INTEGER PRIMARY KEY AUTOINCREMENT,
  UNIQUE(run_id, item_id)
);

-- 未核销清单：INSERT OR IGNORE 保证续扫不重复标记
CREATE TABLE IF NOT EXISTS due_listings(
  run_id TEXT NOT NULL REFERENCES scan_runs(run_id),
  item_id TEXT NOT NULL REFERENCES items(id),
  marked_at TEXT NOT NULL,
  PRIMARY KEY(run_id, item_id)
);
`,
];

function openDatabase(path = process.env.DATABASE_PATH || 'data/trade.sqlite3') {
  const inMemory = path === ':memory:';
  const resolved = inMemory ? ':memory:' : resolve(path);
  if (!inMemory) {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(MIGRATIONS[0]());
  const applied = new Set(
    db.prepare('SELECT version FROM schema_versions').all().map((r) => r.version),
  );
  for (let version = 1; version <= MIGRATIONS.length; version += 1) {
    if (!applied.has(version)) {
      db.exec(MIGRATIONS[version - 1]());
      db.prepare('INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES(?, ?)').run(
        version,
        new Date().toISOString(),
      );
    }
  }
  return db;
}

module.exports = { openDatabase };
