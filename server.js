// 启动入口：业务规则在 lib/rules.js，数据保存在 lib/store.js，接口在 lib/api.js。
const http = require("http");
const { handleRequest } = require("./lib/api");

const PORT = Number(process.env.PORT || 3020);

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
