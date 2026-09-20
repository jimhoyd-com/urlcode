const { createApp } = require('./app');
const port = Number(process.env.PORT) || 3000;
const app = createApp();
const server = app.listen(port, () => console.log(`Blog listening on http://localhost:${port}`));
const stop = () => server.close(() => { app.close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
