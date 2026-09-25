// 接口：HTTP 路由与请求响应。规则判断走 rules.js，数据读写走 store.js。
const { readDb, writeDb } = require("./store");
const rules = require("./rules");

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

const REMOVAL_REASON = "耐受温度与批次共同工艺窗口无交集";

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function conflictInfo(damage) {
  return {
    id: damage.id,
    position: damage.position,
    type: damage.type,
    minTemp: damage.minTemp,
    maxTemp: damage.maxTemp
  };
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    commonWindow: batch.commonWindow || rules.commonWindow(damages),
    removals: batch.removals || [],
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl", "minTemp", "maxTemp"]);
    const tempError = rules.validateTempRange(body.minTemp, body.maxTemp);
    if (tempError) return send(res, 400, { error: tempError });
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      minTemp: body.minTemp,
      maxTemp: body.maxTemp,
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);

    const touchesTemp = body.minTemp !== undefined || body.maxTemp !== undefined;
    const nextMinTemp = body.minTemp !== undefined ? body.minTemp : damage.minTemp;
    const nextMaxTemp = body.maxTemp !== undefined ? body.maxTemp : damage.maxTemp;
    if (touchesTemp) {
      const tempError = rules.validateTempRange(nextMinTemp, nextMaxTemp);
      if (tempError) return send(res, 400, { error: tempError });
    }
    const tempsChanged = touchesTemp && (nextMinTemp !== damage.minTemp || nextMaxTemp !== damage.maxTemp);

    let batch = null;
    if (tempsChanged && damage.batchId) {
      batch = db.batches.find((item) => item.id === damage.batchId) || null;
      if (batch && batch.status === "completed") {
        return send(res, 409, { error: "批次已完成，不许再改动温度范围" });
      }
    }

    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote,
      minTemp: nextMinTemp,
      maxTemp: nextMaxTemp
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;

    // 温度范围变更后重新判断所在批次：不能继续共批的缺损回到待修并移出
    let reevaluation = null;
    if (batch) {
      const members = db.damages.filter((item) => batch.damageIds.includes(item.id));
      const result = rules.reevaluateBatch(members);
      const removedAt = new Date().toISOString();
      const removed = result.removed.map((item) => {
        item.batchId = null;
        item.status = "pending";
        return {
          damageId: item.id,
          minTemp: item.minTemp,
          maxTemp: item.maxTemp,
          removedAt,
          reason: REMOVAL_REASON
        };
      });
      if (removed.length) {
        const removedIds = new Set(removed.map((record) => record.damageId));
        batch.damageIds = batch.damageIds.filter((id) => !removedIds.has(id));
        batch.removals = (batch.removals || []).concat(removed);
      }
      batch.commonWindow = result.window;
      reevaluation = { batchId: batch.id, commonWindow: result.window, removed };
    }

    await writeDb(db);
    return send(res, 200, reevaluation ? { data: damage, reevaluation } : { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
    const members = db.damages.filter((damage) => body.damageIds.includes(damage.id));
    const noTemp = members.filter((damage) => !rules.hasTempRange(damage));
    if (noTemp.length) return send(res, 400, { error: `缺损项未登记耐受温度：${noTemp.map((damage) => damage.id).join(", ")}` });

    // 建批前先算共同工艺窗口；没有交集就退回并指出冲突项，批次归属不改
    const check = rules.evaluateBatch(members);
    if (!check.ok) {
      return send(res, 409, {
        error: "缺损耐受温度没有共同工艺窗口，批次未创建",
        conflicts: check.conflicts.map(conflictInfo),
        detail: {
          highestMinTemp: Math.max(...members.map((damage) => damage.minTemp)),
          lowestMaxTemp: Math.min(...members.map((damage) => damage.maxTemp))
        }
      });
    }

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      commonWindow: check.window,
      removals: [],
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status === "completed") return send(res, 409, { error: "批次已完成，不许再改" });
    const members = db.damages.filter((item) => batch.damageIds.includes(item.id));
    const window = batch.commonWindow || rules.commonWindow(members);
    if (!window) return send(res, 409, { error: "批次没有共同工艺窗口，不能完成" });
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    batch.commonWindow = window;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

async function handleRequest(req, res) {
  try {
    await handle(req, res);
  } catch (error) {
    send(res, error.status || 500, { error: error.message || "服务器错误" });
  }
}

module.exports = { handleRequest };
