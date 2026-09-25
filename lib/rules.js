// 规则：耐受温度校验、共同工艺窗口（区间交集）、冲突项与移出判断。
// 纯函数，不触碰存储与HTTP。

function isTemp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasTempRange(damage) {
  return isTemp(damage.minTemp) && isTemp(damage.maxTemp);
}

// 返回错误消息，合法则返回 null
function validateTempRange(minTemp, maxTemp) {
  if (!isTemp(minTemp) || !isTemp(maxTemp)) return "最低和最高耐受温度都必须是数字";
  if (minTemp > maxTemp) return "最低耐受温度不能高于最高耐受温度";
  return null;
}

// 共同工艺窗口：所有缺损耐受区间的交集；任意一项未登记或无交集时返回 null
function commonWindow(damages) {
  if (!damages.length || damages.some((damage) => !hasTempRange(damage))) return null;
  const minTemp = Math.max(...damages.map((damage) => damage.minTemp));
  const maxTemp = Math.min(...damages.map((damage) => damage.maxTemp));
  return minTemp <= maxTemp ? { minTemp, maxTemp } : null;
}

// 最大相容子集：找到被最多区间共同覆盖的温度点，保留所有覆盖该点的缺损，
// 其余即为无法共批的项（移出项数最少，结果确定）
function largestCompatibleSet(damages) {
  const events = [];
  damages.forEach((damage) => {
    events.push({ temp: damage.minTemp, delta: 1 });
    events.push({ temp: damage.maxTemp, delta: -1 });
  });
  events.sort((a, b) => a.temp - b.temp || b.delta - a.delta);
  let depth = 0;
  let bestDepth = 0;
  let bestTemp = null;
  events.forEach((event) => {
    depth += event.delta;
    if (depth > bestDepth) {
      bestDepth = depth;
      bestTemp = event.temp;
    }
  });
  const covers = (damage) => damage.minTemp <= bestTemp && bestTemp <= damage.maxTemp;
  return {
    kept: damages.filter(covers),
    removed: damages.filter((damage) => !covers(damage))
  };
}

// 建批检查：全部满足则给出共同区间，否则给出需要移出才能成批的冲突项
function evaluateBatch(damages) {
  const window = commonWindow(damages);
  if (window) return { ok: true, window, conflicts: [] };
  const { removed } = largestCompatibleSet(damages.filter(hasTempRange));
  return { ok: false, window: null, conflicts: removed };
}

// 温度变更后的重新判断：交集仍在则只更新窗口；
// 交集消失则移出不能继续共批的缺损，剩余项重算窗口
function reevaluateBatch(damages) {
  const window = commonWindow(damages);
  if (window) return { window, removed: [] };
  const { kept, removed } = largestCompatibleSet(damages);
  return { window: commonWindow(kept), removed };
}

module.exports = {
  hasTempRange,
  validateTempRange,
  commonWindow,
  evaluateBatch,
  reevaluateBatch
};
