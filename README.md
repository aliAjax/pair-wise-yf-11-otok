# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

## 代码结构

- `lib/rules.js` — 规则：耐受温度校验、共同工艺窗口（区间交集）、冲突项与移出判断
- `lib/store.js` — 保存：读写 `data/db.json`（数据仍写现有文件）
- `lib/api.js` — 接口：HTTP 路由与请求响应
- `server.js` — 启动入口

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`

## 共同工艺窗口

- 登记缺损时必须带 `minTemp`、`maxTemp`（最低/最高耐受温度，数字，且最低不高于最高）。
- `POST /batches` 建批时计算所有缺损都满足的交集区间：
  - 有交集：批次创建成功，批次记录 `commonWindow`，缺损进入 `in_repair`。
  - 无交集：返回 `409` 与 `conflicts` 冲突项，不建批，缺损批次归属不变。
- `PATCH /damages/:id` 改动温度范围后，自动重新判断其所在的未完结批次：
  - 交集仍在：只更新批次 `commonWindow`。
  - 交集消失：不能继续共批的缺损回到 `pending` 并移出批次，移出记录写入批次 `removals`，响应附带 `reevaluation`（共同区间 + 本次移出记录）。
- 批次详情（`GET /batches`、`GET /batches/:id`）返回 `commonWindow` 和 `removals` 移出记录。
- 已完成批次不许再改：改动其缺损的温度范围、重复完成批次均返回 `409`。

## 闭环示例

```bash
# 登记缺损时带上耐受温度
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/damages \
  -H 'Content-Type: application/json' \
  -d '{"position":"中部虫洞","type":"虫蛀孔","beforePhotoUrl":"https://example.local/before-014-3.jpg","minTemp":58,"maxTemp":88}'

curl http://127.0.0.1:3020/damages?status=pending

# 建批：成功则返回共同工艺窗口 commonWindow
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 改动温度范围：触发所在批次重新判断，响应带 reevaluation
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_2 \
  -H 'Content-Type: application/json' \
  -d '{"minTemp":70,"maxTemp":95}'
```
