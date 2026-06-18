/**
 * 无缝切换账号 HTTP 服务器
 * 参考 MyCursor-main 的 http_server.rs 实现
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

let server = null;
let accountCache = [];
let dataDir = null;

/**
 * 设置数据目录和账号缓存
 * @param {string} dir - 数据目录路径
 * @param {Array} accounts - 账号列表
 */
function setAccountData(dir, accounts) {
  dataDir = dir;
  accountCache = accounts || [];
}

/**
 * 处理 CORS 头部
 * @param {http.ServerResponse} res - 响应对象
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

/**
 * 发送 JSON 响应
 * @param {http.ServerResponse} res - 响应对象
 * @param {number} status - HTTP 状态码
 * @param {object} body - 响应体
 */
function sendJsonResponse(res, status, body) {
  setCorsHeaders(res);
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

/**
 * 处理 /api/accounts 请求
 * @param {http.ServerResponse} res - 响应对象
 */
function handleAccounts(res) {
  sendJsonResponse(res, 200, { code: 0, data: accountCache });
}

/**
 * 处理 /api/switch 请求
 * @param {http.ServerRequest} req - 请求对象
 * @param {http.ServerResponse} res - 响应对象
 */
function handleSwitch(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const switchReq = JSON.parse(body);
      const email = switchReq.email;

      const account = accountCache.find(a => a.email === email);
      if (account) {
        sendJsonResponse(res, 200, {
          code: 0,
          data: {
            token: account.accessToken || account.token,
            email: account.email,
            refresh_token: account.refreshToken || account.refresh_token,
            machine_ids: account.machineIds || account.machine_ids
          }
        });
      } else {
        sendJsonResponse(res, 404, { code: 1, msg: '未找到' });
      }
    } catch (e) {
      sendJsonResponse(res, 400, { code: 1, msg: e.message });
    }
  });
}

/**
 * 创建并启动 HTTP 服务器
 * @param {number} port - 端口号
 * @param {string} dir - 数据目录
 * @param {Array} accounts - 账号列表
 * @returns {Promise<{ success: boolean, port: number }>}
 */
function startServer(port, dir, accounts) {
  return new Promise((resolve, reject) => {
    if (server) {
      setAccountData(dir, accounts);
      resolve({ success: true, port, alreadyRunning: true });
      return;
    }

    setAccountData(dir, accounts);

    server = http.createServer((req, res) => {
      const url = req.url;
      const method = req.method;

      if (method === 'OPTIONS') {
        sendJsonResponse(res, 200, {});
        return;
      }

      if (method === 'GET' && url === '/api/health') {
        sendJsonResponse(res, 200, { status: 'ok' });
      } else if (method === 'GET' && url === '/api/accounts') {
        handleAccounts(res);
      } else if (method === 'POST' && url === '/api/switch') {
        handleSwitch(req, res);
      } else {
        sendJsonResponse(res, 404, { code: 1 });
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[Seamless] 服务器已启动: http://127.0.0.1:${port}`);
      resolve({ success: true, port });
    });

    server.on('error', (err) => {
      console.error('[Seamless] 服务器错误:', err);
      reject(err);
    });
  });
}

/**
 * 停止 HTTP 服务器
 * @returns {Promise<{ success: boolean }>}
 */
function stopServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log('[Seamless] 服务器已停止');
        server = null;
        resolve({ success: true });
      });
    } else {
      resolve({ success: true });
    }
  });
}

/**
 * 检查服务器是否正在运行
 * @returns {boolean}
 */
function isServerRunning() {
  return server !== null;
}

module.exports = {
  startServer,
  stopServer,
  isServerRunning,
  setAccountData
};
