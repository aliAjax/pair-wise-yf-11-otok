// 共同工艺窗口规则：耐受温度登记校验、共同区间（交集）计算、冲突判定与批次重估。
// 只放业务规则，不触碰存储与 HTTP。

function isTemp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasTempRange(damage) {
  return isTemp(damage.tempMin) && isTemp(damage.tempMax);
}

function validateTempRange(tempMin, tempMax) {
  if (!isTemp(tempMin) || !isTemp(tempMax)) return "tempMin和tempMax必须是数字（摄氏度）";
  if (tempMin > tempMax) return `最低耐受温度不能高于最高耐受温度（${tempMin} > ${tempMax}）`;
  return null;
}

// 所有缺损都满足的加温区间：最高的最低温 ~ 最低的最高温；无交集返回 null
function commonWindow(damages) {
  if (!damages.length || !damages.every(hasTempRange)) return null;
  const min = Math.max(...damages.map((item) => item.tempMin));
  const max = Math.min(...damages.map((item) => item.tempMax));
  return min <= max ? { min, max } : null;
}

function conflictInfo(damage) {
  return {
    id: damage.id,
    position: damage.position,
    type: damage.type,
    tempMin: damage.tempMin,
    tempMax: damage.tempMax
  };
}

// 交集为空时顶穿窗口的缺损：耐受上限够不到共同下限，或耐受下限超过共同上限
function findConflicts(damages) {
  if (!damages.length || !damages.every(hasTempRange)) return [];
  const min = Math.max(...damages.map((item) => item.tempMin));
  const max = Math.min(...damages.map((item) => item.tempMax));
  if (min <= max) return [];
  return damages.filter((item) => item.tempMax < min || item.tempMin > max);
}

// 温度范围改动后重估批次：
// - 仍有共同区间：只更新批次窗口
// - 失去共同区间：无法继续共批的缺损移出批次、打回待修并留下移出记录
function reevaluateBatch(db, batch, changedDamageId) {
  const membersOf = () => db.damages.filter((item) => batch.damageIds.includes(item.id));
  let window = commonWindow(membersOf());
  const removed = [];
  if (!window) {
    let targets = findConflicts(membersOf());
    // 改动前批次窗口必然成立，优先只移出被改动的缺损，保住其余成员
    if (changedDamageId && batch.damageIds.includes(changedDamageId)) {
      const rest = membersOf().filter((item) => item.id !== changedDamageId);
      if (commonWindow(rest)) targets = membersOf().filter((item) => item.id === changedDamageId);
    }
    const targetIds = new Set(targets.map((item) => item.id));
    const removedAt = new Date().toISOString();
    targets.forEach((damage) => {
      damage.status = "pending";
      damage.batchId = null;
      removed.push({
        damageId: damage.id,
        position: damage.position,
        type: damage.type,
        tempMin: damage.tempMin,
        tempMax: damage.tempMax,
        reason: "温度范围改动后与批次共同工艺窗口无交集",
        removedAt
      });
    });
    batch.damageIds = batch.damageIds.filter((id) => !targetIds.has(id));
    batch.removals = (batch.removals || []).concat(removed);
    window = commonWindow(membersOf());
  }
  batch.tempWindow = window;
  return { window, removed };
}

module.exports = {
  hasTempRange,
  validateTempRange,
  commonWindow,
  findConflicts,
  conflictInfo,
  reevaluateBatch
};
