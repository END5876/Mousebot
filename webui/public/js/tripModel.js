'use strict';
// 資料模型與純計算：defaultTrip/repairTrip 系列、淨額與債務簡化計算（calcNetBalances/simplifyDebts/calcPairwiseDebts）。
function defaultTrip(){
  return {
    id: genId('trip'),
    name: '未命名行程',
    baseCurrency: 'TWD',
    rates: { TWD: 1 },
    members: [],
    expenses: [],
    deposits: [],
    archived: false,
    createdAt: Date.now(),
  };
}

function repairTrip(raw){
  const def = defaultTrip();
  const t = Object.assign({}, def, raw||{});
  t.rates = Object.assign({}, def.rates, (raw&&raw.rates)||{});
  if (!t.rates[t.baseCurrency]) t.rates[t.baseCurrency] = 1;
  t.members = Array.isArray(t.members) ? t.members.map(m=>({id:m.id||genId('mem'), name:m.name||m.id||'未知成員'})) : [];
  t.expenses = Array.isArray(t.expenses) ? t.expenses.map(repairExpense) : [];
  t.deposits = Array.isArray(t.deposits) ? t.deposits.map(repairDeposit) : [];
  // 🆕 保留 shareLinks 欄位（不在前端修改，只是原封不動傳回伺服器）
  t.shareLinks = Array.isArray(raw&&raw.shareLinks) ? raw.shareLinks : [];
  if (typeof t.archived !== 'boolean') t.archived = false;
  if (typeof t.createdAt !== 'number') t.createdAt = Date.now();
  // 🆕 保留 updatedAt 時間戳記，用於多人協作版本比對
  if (typeof (raw&&raw.updatedAt) === 'number') t.updatedAt = raw.updatedAt;
  if (!t.id) t.id = genId('trip');
  if (!t.name) t.name = '未命名行程';
  return t;
}
function repairExpense(e){
  e = e || {};
  return {
    id: e.id || genId('exp'),
    description: e.description || '（無說明）',
    amount: typeof e.amount === 'number' ? e.amount : 0,
    currency: e.currency || 'TWD',
    amountInBase: typeof e.amountInBase === 'number' ? e.amountInBase : (typeof e.amount==='number'?e.amount:0),
    payers: Array.isArray(e.payers) ? e.payers.map(p=>({userId:p.userId, amount: typeof p.amount==='number'?p.amount:0})) : [],
    participants: Array.isArray(e.participants) ? e.participants.map(s=>({userId:s.userId, amount: typeof (s.amount??s.share)==='number'?(s.amount??s.share):0})) : [],
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
    createdBy: e.createdBy || 'web-ui',
  };
}
function repairDeposit(d){
  d = d || {};
  return {
    id: d.id || genId('dep'),
    collectorId: d.collectorId || null,
    payerId: d.payerId || null,
    amount: typeof d.amount === 'number' ? d.amount : 0,
    currency: d.currency || 'TWD',
    amountInBase: typeof d.amountInBase === 'number' ? d.amountInBase : (typeof d.amount==='number'?d.amount:0),
    note: d.note || '',
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
  };
}

function toBase(amount, currency, rates){
  const rate = rates[currency];
  if (typeof rate !== 'number' || rate <= 0) return null;
  return round2(amount * rate);
}
function equalSplit(amount, ids){
  const n = ids.length;
  if (!n) return [];
  const base = round2(amount/n);
  let acc = 0;
  return ids.map((id,i)=>{
    let share;
    if (i === n-1) share = round2(amount - acc);
    else { share = base; acc = round2(acc + share); }
    return { userId:id, amount: share };
  });
}
function convertToBase(amount, exp){
  if (!exp.amount || exp.amount === 0) return 0;
  const ratio = exp.amountInBase / exp.amount;
  return round2(amount * ratio);
}
function allocateExpenseBaseAmounts(entries, exp){
  let allocated = 0;
  return entries.map((entry, index)=>{
    const amountInBase = index === entries.length - 1
      ? round2(exp.amountInBase - allocated)
      : convertToBase(entry.amount, exp);
    allocated = round2(allocated + amountInBase);
    return Object.assign({}, entry, { amountInBase });
  });
}
function calcNetBalances(trip){
  const net = {};
  for (const m of trip.members) net[m.id] = 0;
  for (const exp of trip.expenses){
    for (const p of allocateExpenseBaseAmounts(exp.payers, exp)){
      if (net[p.userId] !== undefined) net[p.userId] = round2(net[p.userId] + p.amountInBase);
    }
    for (const s of allocateExpenseBaseAmounts(exp.participants, exp)){
      if (net[s.userId] !== undefined) net[s.userId] = round2(net[s.userId] - s.amountInBase);
    }
  }
  for (const d of trip.deposits){
    if (net[d.payerId] !== undefined) net[d.payerId] = round2(net[d.payerId] + d.amountInBase);
    if (net[d.collectorId] !== undefined) net[d.collectorId] = round2(net[d.collectorId] - d.amountInBase);
  }
  return net;
}
function simplifyDebts(net){
  const debtors=[], creditors=[];
  for (const [id, amount] of Object.entries(net)){
    const a = round2(amount);
    if (a < -0.01) debtors.push({id, amount: round2(-a)});
    else if (a > 0.01) creditors.push({id, amount:a});
  }
  debtors.sort((a,b)=>b.amount-a.amount);
  creditors.sort((a,b)=>b.amount-a.amount);
  const tx=[]; let i=0,j=0;
  while (i<debtors.length && j<creditors.length){
    const d=debtors[i], c=creditors[j];
    const amount = round2(Math.min(d.amount,c.amount));
    if (amount > 0.01) tx.push({from:d.id, to:c.id, amount});
    d.amount = round2(d.amount-amount); c.amount = round2(c.amount-amount);
    if (d.amount<=0.01) i++;
    if (c.amount<=0.01) j++;
  }
  return tx;
}

/* =====================================================================
   🆕 Overview: 彼此累計欠款總額（非最少筆數簡化版）
   ---------------------------------------------------------------------
   simplifyDebts() 是對「淨額」做貪心配對，目的是算出「最少轉帳筆數」，
   過程中會把不同人之間本來沒有直接往來的債務跨人合併（例如 A欠B、B欠C，
   可能被簡化成「A直接付給C」），對「最省事的還款方案」來說很好用，但不
   等於「A、B、C 彼此之間實際各欠了多少」。

   這裡改成忠實地重建「原始配對關係」：
   1. 每筆支出：把每位分攤者的份額，依「各代墊人實際付款比例」拆分，
      分別記到「這位分攤者欠這位代墊人多少」（多代墊人時，比例分配到每
      個代墊人身上，而不是全部歸給第一個代墊人）。
   2. 每筆訂金：收款人視為欠付款人（與 calcNetBalances 的方向一致），
      直到之後有支出把這筆欠款「用掉」。
   3. 最後只在「同一組兩人之間」互相抵銷（A欠B 100、B欠A 30 → 顯示 A欠B 70），
      不會像 simplifyDebts() 那樣跨第三人合併。
===================================================================== */
function calcPairwiseDebts(trip){
  const matrix = {}; // matrix[oweId][owedToId] = 金額（oweId 欠 owedToId 多少）
  const addDebt = (oweId, owedToId, amount) => {
    if (!oweId || !owedToId || oweId === owedToId) return;
    if (!(amount > 0.001)) return;
    if (!matrix[oweId]) matrix[oweId] = {};
    matrix[oweId][owedToId] = round2((matrix[oweId][owedToId] || 0) + amount);
  };

  for (const exp of trip.expenses){
    const payers = allocateExpenseBaseAmounts(exp.payers, exp);
    const participants = allocateExpenseBaseAmounts(exp.participants, exp);
    const totalPaidBase = round2(payers.reduce((s,p)=>s+p.amountInBase,0));
    if (!(totalPaidBase > 0)) continue;
    for (const s of participants){
      if (!(s.amountInBase > 0)) continue;
      for (const p of payers){
        if (!(p.amountInBase > 0)) continue;
        // 這位分攤者「應付給這位代墊人」的份額 = 分攤金額 × (此代墊人出的錢 / 總代墊金額)
        const portion = round2(s.amountInBase * (p.amountInBase / totalPaidBase));
        addDebt(s.userId, p.userId, portion);
      }
    }
  }

  for (const d of trip.deposits){
    // 跟 calcNetBalances 方向一致：收款人（collector）欠付款人（payer）這筆錢，
    // 之後若有花費由收款人代墊支出，會在上面的迴圈裡自然被抵銷掉。
    addDebt(d.collectorId, d.payerId, d.amountInBase);
  }

  const ids = new Set();
  for (const a of Object.keys(matrix)){
    ids.add(a);
    for (const b of Object.keys(matrix[a])) ids.add(b);
  }
  const idList = Array.from(ids);
  const result = [];
  for (let i = 0; i < idList.length; i++){
    for (let j = i + 1; j < idList.length; j++){
      const a = idList[i], b = idList[j];
      const aOwesB = (matrix[a] && matrix[a][b]) || 0;
      const bOwesA = (matrix[b] && matrix[b][a]) || 0;
      const net = round2(aOwesB - bOwesA);
      if (net > 0.01) result.push({ from: a, to: b, amount: net });
      else if (net < -0.01) result.push({ from: b, to: a, amount: round2(-net) });
    }
  }
  result.sort((x,y)=>y.amount-x.amount);
  return result;
}

