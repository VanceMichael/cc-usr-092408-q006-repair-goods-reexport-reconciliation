const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

// 迁移按版本顺序执行，已应用的版本跳过，SQLite 重开后不重复建表。
const MIGRATIONS = [
  {
    version: 1,
    note: '基线：健康入口与迁移版本表',
    sql: '',
  },
  {
    version: 2,
    note: '维修货物复运核销链',
    sql: `
-- 出境申请：固定原报关单、申报状态、维修期限与允许承修方
CREATE TABLE outbound_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_no TEXT NOT NULL UNIQUE,
  declaration_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'declared',
  repair_deadline TEXT NOT NULL,
  repairer TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 原设备：序列号在申请内唯一，期限自申请复制，延期/停止在设备级留痕
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES outbound_applications(id),
  serial_no TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  weight_kg REAL,
  repair_deadline TEXT NOT NULL,
  deadline_stopped_at TEXT,
  UNIQUE(application_id, serial_no)
);

-- 附件清单
CREATE TABLE accessories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

-- 核销台账：已核销、待处置、已处置互不重叠，合计不超过出境总量
CREATE TABLE device_accounts (
  device_id INTEGER PRIMARY KEY REFERENCES devices(id),
  total_qty INTEGER NOT NULL,
  verified_qty INTEGER NOT NULL DEFAULT 0 CHECK (verified_qty >= 0),
  pending_disposal_qty INTEGER NOT NULL DEFAULT 0 CHECK (pending_disposal_qty >= 0),
  disposed_qty INTEGER NOT NULL DEFAULT 0 CHECK (disposed_qty >= 0),
  CHECK (verified_qty + pending_disposal_qty + disposed_qty <= total_qty)
);

-- 部件谱系节点
CREATE TABLE components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  label TEXT NOT NULL,
  serial_no TEXT,
  kind TEXT NOT NULL,
  event_id INTEGER
);

-- 谱系事件：检测、拆解、替换、重新装配只追加不修改
CREATE TABLE lineage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('detection','disassembly','replacement','reassembly')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 谱系边：替换件必须说明与原件的一对一或组合对应
CREATE TABLE lineage_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES lineage_events(id),
  from_component_id INTEGER NOT NULL REFERENCES components(id),
  to_component_id INTEGER NOT NULL REFERENCES components(id),
  relation TEXT NOT NULL CHECK (relation IN ('one_to_one','combination'))
);

-- 维修方案变更：与复运确认共用申请版本号，并发时只有一个生效
CREATE TABLE plan_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES outbound_applications(id),
  note TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 复运批次（返运包装）
CREATE TABLE return_shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES outbound_applications(id),
  package_no TEXT NOT NULL UNIQUE,
  carrier_receipt_no TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  base_version INTEGER,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

-- 复运明细：申报数与实到数分开记录，差异进人工比对
CREATE TABLE return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES return_shipments(id),
  device_id INTEGER NOT NULL REFERENCES devices(id),
  serial_no TEXT NOT NULL,
  declared_qty INTEGER NOT NULL CHECK (declared_qty > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  weight_kg REAL,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- 离线承运回执：按自身流水号去重
CREATE TABLE carrier_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT NOT NULL UNIQUE,
  shipment_id INTEGER REFERENCES return_shipments(id),
  payload TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL
);

-- 人工比对：少件、增件、序列号变化、重量偏差，逐条处理不被覆盖
CREATE TABLE discrepancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  shipment_id INTEGER REFERENCES return_shipments(id),
  return_item_id INTEGER REFERENCES return_items(id),
  type TEXT NOT NULL CHECK (type IN ('shortage','overage','serial_change','weight_deviation')),
  quantity INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);

-- 独立审批：延期、转售、报废、正式进口，记录原期限如何停止或延续
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  type TEXT NOT NULL CHECK (type IN ('extension','resale','scrap','formal_import')),
  quantity INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  previous_deadline TEXT,
  new_deadline TEXT,
  deadline_action TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

-- 到期扫描游标：中断后从游标继续
CREATE TABLE scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0,
  last_device_id INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 未核销标记：同一轮扫描内设备唯一，重跑不重复标记
CREATE TABLE unverified_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  epoch INTEGER NOT NULL,
  reason TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  UNIQUE(device_id, epoch)
);
`,
  },
];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const applied = new Set(db.prepare('SELECT version FROM schema_versions').all().map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      if (migration.sql.trim()) db.exec(migration.sql);
      db.prepare('INSERT INTO schema_versions(version, applied_at) VALUES(?, ?)').run(migration.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function openDatabase(path = process.env.DATABASE_PATH || 'data/trade.sqlite3') {
  const isMemory = path === ':memory:';
  const target = isMemory ? path : resolve(path);
  if (!isMemory) mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

module.exports = { openDatabase, MIGRATIONS };
