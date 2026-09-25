const express = require('express');
const { openDatabase } = require('./database');
const { createRepairService, HttpError } = require('./repair-service');

function createApp(db) {
  const app = express();
  app.use(express.json());
  const svc = createRepairService(db);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // ---------- 出境申请 ----------
  app.post('/api/applications', (req, res, next) => {
    try {
      res.status(201).json(svc.createApplication(req.body));
    } catch (err) { next(err); }
  });
  app.get('/api/applications/:id', (req, res, next) => {
    try { res.json(svc.getApplication(req.params.id)); } catch (err) { next(err); }
  });
  app.post('/api/applications/:id/decision', (req, res, next) => {
    try {
      res.json(svc.decideApplication(req.params.id, req.body?.decision));
    } catch (err) { next(err); }
  });

  // ---------- 设备状态与维修谱系 ----------
  app.get('/api/items/:id', (req, res, next) => {
    try { res.json(svc.itemStatus(req.params.id)); } catch (err) { next(err); }
  });
  app.get('/api/items/:id/genealogy', (req, res, next) => {
    try { res.json(svc.getGenealogy(req.params.id)); } catch (err) { next(err); }
  });
  app.post('/api/items/:id/events', (req, res, next) => {
    try {
      res.status(201).json(svc.appendGenealogyEvent(req.params.id, req.body));
    } catch (err) { next(err); }
  });

  // ---------- 分批复运 ----------
  app.post('/api/items/:id/return-batches', (req, res, next) => {
    try {
      res.status(201).json(svc.planReturnBatch(req.params.id, req.body));
    } catch (err) { next(err); }
  });
  app.get('/api/return-batches/:id', (req, res, next) => {
    try { res.json(svc.getBatchDetail(req.params.id)); } catch (err) { next(err); }
  });
  app.post('/api/return-batches/:id/confirm', (req, res, next) => {
    try { res.json(svc.confirmReturnBatch(req.params.id, req.body || {})); }
    catch (err) { next(err); }
  });
  app.post('/api/manual-reviews/:id/resolve', (req, res, next) => {
    try { res.json(svc.resolveManualReview(req.params.id, req.body || {})); }
    catch (err) { next(err); }
  });

  // ---------- 离线承运回执 ----------
  app.post('/api/carrier-receipts', (req, res, next) => {
    try {
      const result = svc.ingestCarrierReceipt(req.body);
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) { next(err); }
  });
  app.post('/api/carrier-receipts/:receiptNo/link', (req, res, next) => {
    try {
      res.json(svc.linkReceiptToBatch(req.params.receiptNo, req.body?.batch_id));
    } catch (err) { next(err); }
  });

  // ---------- 延期 / 转售 / 报废 / 正式进口 ----------
  app.post('/api/items/:id/dispositions', (req, res, next) => {
    try { res.status(201).json(svc.submitDisposition(req.params.id, req.body)); }
    catch (err) { next(err); }
  });
  app.post('/api/dispositions/:id/decision', (req, res, next) => {
    try { res.json(svc.decideDisposition(req.params.id, req.body || {})); }
    catch (err) { next(err); }
  });

  // ---------- 维修方案版本 ----------
  app.post('/api/items/:id/plans', (req, res, next) => {
    try { res.status(201).json(svc.proposePlan(req.params.id, req.body || {})); }
    catch (err) { next(err); }
  });
  app.post('/api/plans/:id/effective', (req, res, next) => {
    try { res.json(svc.effectivePlan(req.params.id)); } catch (err) { next(err); }
  });

  // ---------- 到期扫描 ----------
  app.post('/api/scan/due', (req, res, next) => {
    try { res.json(svc.runDueScan(req.body || {})); } catch (err) { next(err); }
  });

  // ---------- 全链追溯 ----------
  app.get('/api/trace/packages/:packNo', (req, res, next) => {
    try { res.json(svc.tracePackage(req.params.packNo)); } catch (err) { next(err); }
  });

  // ---------- 统一错误处理 ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON' });
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: '内部错误' });
  });

  return app;
}

function createDefaultApp() {
  return createApp(openDatabase());
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  createDefaultApp().listen(port, host);
}

module.exports = { createApp, createDefaultApp };
