/**
 * quiz-engine.js
 * ────────────────────────────────────────────────────────────
 * 可跨遊戲共用的「出題邏輯」模組。
 *
 * 設計原則：
 *   1. 這個檔案不認得任何「這款遊戲」的東西（沒有金幣、經驗值、TTS、UI）。
 *   2. 進度資料（數學難度階段、各科關卡解鎖進度、防重複出題記錄）的
 *      「結構」與「怎麼推進」都定義在這裡，但資料本身由呼叫端（各遊戲）
 *      持有並負責存檔／讀檔，所以每個遊戲的進度不會互相污染。
 *   3. 題庫內容（BUILTIN_Q / 自訂題庫 / 匯入的 questions.json）不由本模組
 *      保管，每次呼叫時由遊戲端傳入（bank 參數），因為不同遊戲可能想用
 *      不同題庫來源或載入方式。
 *
 * 使用方式：
 *   <script src="quiz-engine.js"></script>
 *   const progress = QuizEngine.createProgress();      // 新玩家
 *   // 或：const progress = 存檔.quizProgress;          // 讀檔還原舊玩家進度
 *
 *   const bank = {
 *     imported: questionsData?.questions || [],  // 從 questions.json 匯入的陣列
 *     custom:   state.customQ,                   // { math:[], chinese:[], ... }
 *     builtin:  state.editedBuiltin || BUILTIN_Q, // { math:[], chinese:[], ... }
 *   };
 *
 *   const q = QuizEngine.pickQuestion(progress, 'math', bank);
 *   // ...玩家作答後...
 *   QuizEngine.recordAnswer(progress, 'math', q, {
 *     correct: true,
 *     isFirstAttempt: true,   // 這是不是這題「第一次」作答（非重答補考）
 *     isFinal: true,          // 這次結果是否已經確定（沒有再重答的機會了）
 *   }, bank);
 *
 *   // 存檔時：把 progress 整包（含 JSON.stringify）存進遊戲自己的存檔即可
 * ────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  const SUBJECTS = ['math', 'chinese', 'english', 'science', 'geography'];
  const TIER_SUBJECTS = ['chinese', 'english', 'science', 'geography']; // 有「關卡分批解鎖」機制的科目
  const SUBJECT_CATEGORY_MAP = { math: '數學', chinese: '國文', english: '英文', science: '自然', geography: '社會' };
  const MATH_STAGE_MAX = 300;
  const MEMORY_RATIO = 0.6; // 出題時「記住最近 6 成」避免馬上重複

  // ── 進度資料骨架 ────────────────────────────────────────
  // 每個遊戲各自持有一份，存檔時整包存起來、讀檔時整包丟回來即可。
  function createProgress() {
    return {
      subject: 'math',
      queue: [],

      // 防重複出題（各科目最近出過的題目 key）
      recentKeys: {},

      // 數學難度階段（1~300）
      mathStage: 1,
      mathStageInit: false,
      mathWindowCount: 0,
      mathWindowCorrect: 0,
      mathWindowWrong: 0,

      // 四科（國/英/自/社）關卡解鎖進度：null = 尚未初始化
      tier: { chinese: null, english: null, science: null, geography: null },
    };
  }

  // ── 科目輪替佇列（如果遊戲需要「五科輪流出題」可以用這個）────
  function refillQueue(progress) {
    progress.queue = SUBJECTS.slice();
  }
  function nextSubject(progress) {
    if (!progress.queue || progress.queue.length === 0) refillQueue(progress);
    return progress.queue.shift();
  }

  // ── 數學難度階段設定表 ──────────────────────────────────
  function getMathStageCfg(stage) {
    stage = Math.max(1, Math.min(MATH_STAGE_MAX, Number(stage) || 1));
    const addLimit = 5 + 2 * (stage - 1);
    const cfg = {
      add: { enabled: true, label: '➕ 加法', aMin: Math.ceil(addLimit / 2), aMax: addLimit, bMin: Math.ceil(addLimit / 6), bMax: Math.ceil(addLimit / 3) },
      sub: { enabled: false, label: '➖ 減法', aMin: Math.ceil(addLimit / 2), aMax: addLimit, bMin: Math.ceil(addLimit / 6), bMax: Math.ceil(addLimit / 3) },
      mul: { enabled: false, label: '✖️ 乘法', aMin: 2, aMax: 3, bMin: 1, bMax: 3 },
      div: { enabled: false, label: '➗ 除法', aMin: 6, aMax: Math.min(50, 6 + Math.floor((stage - 40) / 5)), dMin: 2, dMax: Math.min(10, 2 + Math.floor((stage - 40) / 5)) },
      reverseChance: 0,
    };
    if (stage >= 10) { cfg.sub.enabled = true; }
    if (stage >= 25) {
      cfg.mul.enabled = true;
      if (stage < 60) {
        const mulLimit = 3 + Math.floor((stage - 25) / 5);
        cfg.mul.aMax = mulLimit;
        cfg.mul.bMax = mulLimit;
      } else {
        cfg.mul.aMax = 10 + Math.floor((stage - 60) / 5);
        cfg.mul.bMax = Math.min(20, 10 + Math.floor((stage - 60) / 20));
      }
      cfg.mul.aMin = Math.ceil(cfg.mul.aMax / 6);
      cfg.mul.bMin = Math.ceil(cfg.mul.bMax / 6);
    }
    if (stage >= 40) { cfg.div.enabled = true; }
    if (stage >= 70) { cfg.reverseChance = 0.3; }
    return cfg;
  }

  // 老玩家第一次啟用本系統時，依歷史答對數換算起始階段；只會執行一次
  function ensureMathStageInit(progress, historicalMathCorrect) {
    if (progress.mathStageInit) return;
    progress.mathStageInit = true;
    const correct = historicalMathCorrect || 0;
    progress.mathStage = Math.max(1, Math.min(MATH_STAGE_MAX, Math.floor(correct / 30)));
  }

  // 每次「第一次作答」數學題後呼叫，依最近視窗表現動態升降階
  function updateMathStage(progress, firstAttemptCorrect) {
    progress.mathWindowCount = (progress.mathWindowCount || 0) + 1;
    if (firstAttemptCorrect) progress.mathWindowCorrect = (progress.mathWindowCorrect || 0) + 1;
    else progress.mathWindowWrong = (progress.mathWindowWrong || 0) + 1;

    if (progress.mathWindowWrong >= 3) {
      progress.mathStage = Math.max(1, (progress.mathStage || 1) - 1);
      progress.mathWindowCount = 0; progress.mathWindowCorrect = 0; progress.mathWindowWrong = 0;
      return;
    }
    if (progress.mathWindowCount >= 6) {
      if (progress.mathWindowCorrect >= 5) {
        progress.mathStage = Math.min(MATH_STAGE_MAX, (progress.mathStage || 1) + 1);
      }
      progress.mathWindowCount = 0; progress.mathWindowCorrect = 0; progress.mathWindowWrong = 0;
    }
  }

  // ── 數學自動出題 ────────────────────────────────────────
  function generateMath(cfg, stage) {
    cfg = cfg || getMathStageCfg(stage || 1);
    const activeOps = Object.keys(cfg).filter(k => cfg[k] && cfg[k].enabled);
    if (activeOps.length === 0) return { q: '請至少啟用一種運算！', ans: 'OK', opts: ['OK', '好', 'Yes', '是'] };
    const op = activeOps[Math.floor(Math.random() * activeOps.length)];
    const c = cfg[op];
    let a, b, ans, q;
    const ri = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    if (op === 'add') {
      a = ri(c.aMin, c.aMax); b = ri(c.bMin, c.bMax);
      ans = a + b; q = `${a} ＋ ${b} ＝ ？`;
    } else if (op === 'sub') {
      a = ri(c.aMin, c.aMax); b = ri(c.bMin, Math.min(c.bMax, a));
      ans = a - b; q = `${a} － ${b} ＝ ？`;
    } else if (op === 'mul') {
      a = ri(c.aMin, c.aMax); b = ri(c.bMin, c.bMax);
      ans = a * b; q = `${a} × ${b} ＝ ？`;
    } else {
      b = ri(c.dMin, c.dMax);
      const aMinAdj = Math.max(c.aMin, b);
      const aMaxAdj = Math.max(aMinAdj, c.aMax);
      a = ri(aMinAdj, aMaxAdj);
      const quotient = Math.floor(a / b);
      const remainder = a % b;
      ans = remainder === 0 ? String(quotient) : `${quotient}...${remainder}`;
      q = `${a} ÷ ${b} ＝ ？`;
    }
    const wrong = new Set();
    if (op === 'div') {
      const q2 = Math.floor(a / b);
      const r2 = a % b;
      for (let d = 1; wrong.size < 3; d++) {
        const wq = q2 + (wrong.size % 2 === 0 ? d : -d);
        if (wq < 0) { wrong.add(`${q2 + d}...${r2}`); continue; }
        const candidate = r2 === 0 ? String(wq) : `${wq}...${r2}`;
        if (candidate !== ans) wrong.add(candidate);
      }
    } else {
      while (wrong.size < 3) {
        const d = Math.floor(Math.random() * Math.max(3, Math.ceil(ans * 0.3))) + 1;
        const w = Math.random() < 0.5 ? Number(ans) + d : Math.max(0, Number(ans) - d);
        if (String(w) !== String(ans)) wrong.add(String(w));
      }
    }
    const opts = [ans, ...wrong].sort(() => Math.random() - 0.5);
    return { q, ans: String(ans), opts };
  }

  function calcResult(sym, a, b) {
    if (sym === '＋') return a + b;
    if (sym === '－') return a - b;
    if (sym === '×') return a * b;
    if (sym === '÷') return (b !== 0 && a % b === 0) ? a / b : null;
    return null;
  }

  function generateMathReverse(cfg, stage) {
    cfg = cfg || getMathStageCfg(stage || 1);
    const activeOps = Object.keys(cfg).filter(k => cfg[k] && cfg[k].enabled);
    if (activeOps.length < 2) return generateMath(cfg);
    const op = activeOps[Math.floor(Math.random() * activeOps.length)];
    const c = cfg[op];
    const ri = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    let a, b, ans, q;
    if (op === 'add') {
      a = ri(c.aMin, c.aMax); b = ri(c.bMin, c.bMax);
      ans = '＋'; q = `${a} ？ ${b} ＝ ${a + b}`;
    } else if (op === 'sub') {
      a = ri(c.aMin, c.aMax); b = ri(c.bMin, Math.min(c.bMax, a));
      ans = '－'; q = `${a} ？ ${b} ＝ ${a - b}`;
    } else if (op === 'mul') {
      a = ri(c.aMin, c.aMax); b = ri(c.bMin, c.bMax);
      ans = '×'; q = `${a} ？ ${b} ＝ ${a * b}`;
    } else {
      b = ri(c.dMin, c.dMax);
      const aMinAdj = Math.max(c.aMin, b);
      a = ri(aMinAdj, Math.max(aMinAdj, c.aMax));
      if (a % b !== 0) return generateMathReverse(cfg, stage);
      ans = '÷'; q = `${a} ？ ${b} ＝ ${a / b}`;
    }
    const allSymbols = ['＋', '－', '×', '÷'];
    const correctResult = calcResult(ans, a, b);
    const isAmbiguous = allSymbols.some(sym => sym !== ans && calcResult(sym, a, b) === correctResult);
    if (isAmbiguous) return generateMathReverse(cfg, stage);
    const opts = allSymbols.sort(() => Math.random() - 0.5);
    return { q, ans, opts };
  }

  // ── 防重複出題 ──────────────────────────────────────────
  function _qKey(p) {
    if (p && p.id != null) return `${p.id}`;
    return `${p.q}|${p.ans}`;
  }

  function _pickFromPool(progress, subject, pool) {
    if (pool.length === 0) return null;
    if (!progress.recentKeys) progress.recentKeys = {};
    const cap = Math.max(1, Math.ceil(pool.length * MEMORY_RATIO));
    const list = progress.recentKeys[subject] || (progress.recentKeys[subject] = []);
    const fresh = pool.filter(p => !list.includes(_qKey(p)));
    const candidates = fresh.length > 0 ? fresh : pool;
    const p = candidates[Math.floor(Math.random() * candidates.length)];
    const key = _qKey(p);
    list.unshift(key);
    if (list.length > cap) list.length = cap;
    return p;
  }

  // ── 關卡系統（國文/英文/自然/社會，及有題號的數學題）────────
  // bank = { imported: [...], custom: {math:[],...}, builtin: {math:[],...} }
  function getNumberedPool(subject, bank) {
    const cat = SUBJECT_CATEGORY_MAP[subject];
    const toNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const importedRaw = ((bank && bank.imported) || []).filter(x => x.category === cat && toNum(x.id));
    const imported = importedRaw.map(x => ({ q: x.question, ans: x.answer, opts: x.options, img: x.image || x.img, id: toNum(x.id) }));
    const custom = (((bank && bank.custom) || {})[subject] || [])
      .filter(x => toNum(x.id))
      .map(x => ({ ...x, id: toNum(x.id) }));
    const map = new Map();
    imported.forEach(x => map.set(x.id, x));
    custom.forEach(x => map.set(x.id, x)); // 持久化的自訂題庫優先覆蓋
    return Array.from(map.values())
      .filter(x => x.q && x.ans && Array.isArray(x.opts) && x.opts.length >= 2)
      .sort((a, b) => a.id - b.id);
  }

  function recomputePendingBatch(progress, subject, pool) {
    const t = progress.tier[subject];
    if (!t) return;
    const lower = Math.max(1, t.unlockedMax - 4);
    t.pendingIds = pool.filter(p => p.id >= lower && p.id <= t.unlockedMax).map(p => p.id);
  }

  // 初始化某科目關卡狀態（只會做一次）；historicalSubjectCorrect 讓老玩家不用從頭來過
  function ensureTierState(progress, subject, bank, historicalSubjectCorrect) {
    if (!progress.tier) progress.tier = {};
    if (progress.tier[subject]) return;
    const pool = getNumberedPool(subject, bank);
    const correct = historicalSubjectCorrect || 0;
    const maxId = pool.length ? pool[pool.length - 1].id : 0;
    const startMax = pool.length ? Math.min(maxId, Math.max(5, 5 + 5 * Math.floor(correct / 30))) : 5;
    progress.tier[subject] = { unlockedMax: startMax, pendingIds: null, retryQueue: [] };
    recomputePendingBatch(progress, subject, pool);
  }

  function advanceTier(progress, subject, bank) {
    const t = progress.tier[subject];
    const pool = getNumberedPool(subject, bank);
    const maxId = pool.length ? pool[pool.length - 1].id : 0;
    if (t.unlockedMax >= maxId) { t.pendingIds = []; return; }
    t.unlockedMax = Math.min(maxId, t.unlockedMax + 5);
    recomputePendingBatch(progress, subject, pool);
  }

  // 答對某題號時呼叫：從待通過清單移除，全部通過後自動晉級
  function onTierCorrect(progress, subject, id, bank) {
    const t = progress.tier && progress.tier[subject];
    if (!t || !Array.isArray(t.pendingIds) || id == null) return;
    const idx = t.pendingIds.indexOf(id);
    if (idx === -1) return; // 不在本批門檻內（可能是複習舊題），不影響進度
    t.pendingIds.splice(idx, 1);
    if (t.pendingIds.length === 0) advanceTier(progress, subject, bank);
  }

  // 確定答錯（沒有再重答機會了）時呼叫：安排隨機 2~4 題後重新出現
  function scheduleRetry(progress, subject, id) {
    const t = progress.tier && progress.tier[subject];
    if (!t || id == null) return;
    if (t.retryQueue.some(e => e.id === id)) return;
    const wait = 2 + Math.floor(Math.random() * 3);
    t.retryQueue.push({ id, wait });
  }

  function _buildTierEntry(p) {
    const entry = { q: p.q, ans: p.ans, opts: (p.opts || []).slice().sort(() => Math.random() - 0.5), id: p.id };
    if (p.img) entry.img = p.img;
    return entry;
  }

  function pickQuestionTiered(progress, subject, bank, historicalSubjectCorrect) {
    const pool = getNumberedPool(subject, bank);
    if (pool.length === 0) return null;
    ensureTierState(progress, subject, bank, historicalSubjectCorrect);
    const t = progress.tier[subject];
    if (t.retryQueue.length) {
      t.retryQueue.forEach(e => e.wait--);
      const dueIdx = t.retryQueue.findIndex(e => e.wait <= 0);
      if (dueIdx >= 0) {
        const due = t.retryQueue.splice(dueIdx, 1)[0];
        const q = pool.find(p => p.id === due.id);
        if (q) return _buildTierEntry(q);
      }
    }
    const maxId = pool[pool.length - 1].id;
    const upper = Math.min(t.unlockedMax, maxId);
    const candidates = pool.filter(p => p.id <= upper);
    const p = _pickFromPool(progress, subject, candidates.length ? candidates : pool);
    return p ? _buildTierEntry(p) : null;
  }

  // ── 主要出題函式 ────────────────────────────────────────
  // opts（可省略）：{ historicalMathCorrect, historicalSubjectCorrect }，用來讓老玩家換算起始進度
  function pickQuestion(progress, subject, bank, opts) {
    opts = opts || {};
    bank = bank || {};
    if (subject === 'math') {
      ensureMathStageInit(progress, opts.historicalMathCorrect);
      const stage = progress.mathStage || 1;
      const MATH_BANK_RATIO = 0.15; // 固定題庫佔比，0=全隨機出題、1=全題庫
      const numberedMathPool = getNumberedPool('math', bank);
      let mathPool;
      if (numberedMathPool.length > 0) {
        const openCount = Math.min(numberedMathPool.length, Math.max(1, stage));
        mathPool = numberedMathPool.slice(0, openCount);
      } else {
        const mathImported = (bank.imported || []).filter(x => x.category === '數學');
        const mathCustom = (bank.custom && bank.custom.math) || [];
        const mathBuiltin = (bank.builtin && bank.builtin.math) || [];
        mathPool = [
          ...mathImported.map(x => ({ q: x.question, ans: x.answer, opts: x.options, img: x.image || x.img })),
          ...mathCustom,
          ...mathBuiltin,
        ];
      }
      if (mathPool.length > 0 && Math.random() < MATH_BANK_RATIO) {
        const p = _pickFromPool(progress, subject, mathPool);
        if (p) {
          const e = { q: p.q, ans: p.ans, opts: (p.opts || []).slice().sort(() => Math.random() - 0.5) };
          if (p.img) e.img = p.img;
          return e;
        }
      }
      const cfg = getMathStageCfg(stage);
      return Math.random() < cfg.reverseChance ? generateMathReverse(cfg, stage) : generateMath(cfg, stage);
    }

    const tiered = pickQuestionTiered(progress, subject, bank, opts.historicalSubjectCorrect);
    if (tiered) return tiered;

    const catMap = { chinese: '國文', english: '英文', science: '自然', geography: '社會' };
    const imported = (bank.imported || []).filter(x => x.category === (catMap[subject] || subject));
    const custom = (bank.custom && bank.custom[subject]) || [];
    const builtin = (bank.builtin && bank.builtin[subject]) || [];
    const rawPool = [
      ...imported.map(x => ({ q: x.question, ans: x.answer, opts: x.options, img: x.image || x.img })),
      ...custom,
      ...builtin,
    ];
    const pool = rawPool.filter(p => p.q && p.ans && Array.isArray(p.opts) && p.opts.length >= 2);
    if (pool.length === 0) return { q: '題庫是空的！請匯入題目。', ans: 'OK', opts: ['OK', '好', 'Yes', '是'] };
    const p = _pickFromPool(progress, subject, pool);
    const entry = { q: p.q, ans: p.ans, opts: (p.opts || []).slice().sort(() => Math.random() - 0.5) };
    if (p.img) entry.img = p.img;
    return entry;
  }

  // ── 作答結果回報 ────────────────────────────────────────
  // result = { correct, isFirstAttempt, isFinal }
  //   - isFirstAttempt: 這是不是這題「第一次」作答（重答補考時傳 false）
  //   - isFinal: 這次的結果是否已經確定，不會再有重答機會了
  //     （答對永遠算 final；答錯但遊戲還允許重答時傳 false）
  function recordAnswer(progress, subject, question, result, bank) {
    const isTierSubject = TIER_SUBJECTS.includes(subject);
    const id = question && question.id;
    if (result.correct) {
      if (isTierSubject && id != null) onTierCorrect(progress, subject, id, bank);
      if (subject === 'math' && result.isFirstAttempt) updateMathStage(progress, true);
    } else {
      if (subject === 'math' && result.isFirstAttempt) updateMathStage(progress, false);
      if (result.isFinal && isTierSubject && id != null) scheduleRetry(progress, subject, id);
    }
  }

  // ── 對外介面 ────────────────────────────────────────────
  global.QuizEngine = {
    SUBJECTS, TIER_SUBJECTS, SUBJECT_CATEGORY_MAP, MATH_STAGE_MAX,

    createProgress,
    refillQueue, nextSubject,

    getMathStageCfg,
    generateMath, generateMathReverse,

    getNumberedPool,
    pickQuestion, pickQuestionTiered,
    recordAnswer,

    // 進階／個別使用（一般情況下用 pickQuestion + recordAnswer 就夠了）
    ensureMathStageInit, updateMathStage,
    ensureTierState, advanceTier, onTierCorrect, scheduleRetry,
  };

})(typeof window !== 'undefined' ? window : globalThis);
