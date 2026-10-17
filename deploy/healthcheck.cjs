// Liveness only: standby must remain healthy while another owner drains.
const http = require('node:http');
const request = http.get('http://127.0.0.1:3000/live', { timeout: 3000 }, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
