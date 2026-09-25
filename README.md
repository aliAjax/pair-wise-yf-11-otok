# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 文件结构

- `rules.js` —— 业务规则：耐受温度校验、共同工艺窗口（交集）计算、冲突判定、批次重估与移出
- `store.js` —— 保存：`data/db.json` 的读写与初始化
- `server.js` —— 接口：HTTP 路由

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`（须登记 `tempMin`/`tempMax` 耐受温度）
- `GET /damages?status=&type=`
- `PATCH /damages/:id`（改 `tempMin`/`tempMax` 会重估所属批次）
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`（详情含 `tempWindow` 共同区间与 `removals` 移出记录）
- `POST /batches/:id/complete`

## 共同工艺窗口规则

- 每项缺损登记最低/最高耐受温度（`tempMin`/`tempMax`，摄氏度）。
- 建批时计算所有缺损都满足的区间（最高的 `tempMin` ~ 最低的 `tempMax`），存入批次 `tempWindow`。
- 没有交集则建批退回（409），响应 `conflicts` 指出冲突项，缺损的批次归属不变。
- 已在批中的缺损不能重复建批（409）。
- 改动缺损温度范围后重新判断：仍有交集则只更新批次窗口；失去交集则把无法继续共批的缺损移出批次、打回 `pending`，并在批次 `removals` 留下移出记录。
- 批次完成后不许再改：改成员温度、重复完成均返回 409。

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
# 响应 tempWindow 为 {"min":18,"max":45}
```
