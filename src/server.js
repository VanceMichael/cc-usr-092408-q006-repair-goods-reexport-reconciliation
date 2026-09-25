const { openDatabase } = require('./database');
const { createApp } = require('./app');

const db = openDatabase();
const app = createApp(db);

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host);
}

module.exports = app;
