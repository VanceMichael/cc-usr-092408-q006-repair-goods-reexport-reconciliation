const express = require('express');
const service = require('./repair-service');

function createApp(db) {
  const app = express();
  app.use(express.json());

  // 同步处理器抛出的 ServiceError 统一交给错误中间件
  const handle = (fn) => (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
  const idParam = (req, name = 'id') => Number(req.params[name]);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // 出境申请
  app.post('/api/outbound-applications', handle((req, res) => {
    res.status(201).json(service.createOutboundApplication(db, req.body || {}));
  }));
  app.get('/api/outbound-applications/:id', handle((req, res) => {
    res.json(service.getApplication(db, idParam(req)));
  }));

  // 维修方案变更（与复运确认共用申请版本号）
  app.post('/api/outbound-applications/:id/plan-changes', handle((req, res) => {
    res.status(201).json(service.addPlanChange(db, idParam(req), req.body || {}));
  }));

  // 复运批次
  app.post('/api/outbound-applications/:id/return-shipments', handle((req, res) => {
    res.status(201).json(service.createReturnShipment(db, idParam(req), req.body || {}));
  }));
  app.get('/api/return-shipments/:id', handle((req, res) => {
    res.json(service.getShipment(db, idParam(req)));
  }));
  app.post('/api/return-shipments/:id/confirm', handle((req, res) => {
    res.json(service.confirmReturnShipment(db, idParam(req), req.body || {}));
  }));
  app.get('/api/return-shipments/:id/trace', handle((req, res) => {
    res.json(service.traceShipment(db, idParam(req)));
  }));

  // 设备与谱系
  app.get('/api/devices/:id', handle((req, res) => {
    res.json(service.getDevice(db, idParam(req)));
  }));
  app.post('/api/devices/:id/lineage-events', handle((req, res) => {
    res.status(201).json(service.addLineageEvent(db, idParam(req), req.body || {}));
  }));

  // 独立审批与处置确认
  app.post('/api/devices/:id/approvals', handle((req, res) => {
    res.status(201).json(service.requestApproval(db, idParam(req), req.body || {}));
  }));
  app.post('/api/devices/:id/disposals', handle((req, res) => {
    res.json(service.confirmDisposal(db, idParam(req), req.body || {}));
  }));
  app.post('/api/approvals/:id/decide', handle((req, res) => {
    res.json(service.decideApproval(db, idParam(req), req.body || {}));
  }));

  // 人工比对
  app.post('/api/discrepancies/:id/resolve', handle((req, res) => {
    res.json(service.resolveDiscrepancy(db, idParam(req), req.body || {}));
  }));

  // 离线承运回执（按流水号去重）
  app.post('/api/carrier-receipts', handle((req, res) => {
    const result = service.recordCarrierReceipt(db, req.body || {});
    res.status(result.deduplicated ? 200 : 201).json(result);
  }));

  // 到期扫描与未核销清单
  app.post('/api/scan/due', handle((req, res) => {
    res.json(service.scanDue(db, req.body || {}));
  }));
  app.get('/api/scan/unverified', handle((_req, res) => {
    res.json(service.listUnverified(db));
  }));

  // 统一错误格式
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const code = err.code || (status >= 500 ? 'INTERNAL' : 'VALIDATION');
    res.status(status).json({ error: { code, message: err.message } });
  });

  return app;
}

module.exports = { createApp };
