/**
 * indigenous-quiz-engine.js
 * ────────────────────────────────────────────────────────────
 * 族語答題的獨立出題邏輯模組（跟 quiz-engine.js 完全分開，互不依賴）。
 *
 * 單字庫格式（一個詞只需要登記一次，兩種題型共用）：
 *   {
 *     id:       1,              // 辭典順序，從 1 開始遞增的整數（不是任意字串）！
 *                                // 階層解鎖／複習排程都是照這個順序走，順序本身就代表難度／學習進度。
 *     meaning:  '豬',           // 中文意思
 *     spelling: 'babuy',        // 拼音／羅馬字（畫面顯示用）
 *     audio:    'babuy.mp3',    // 這個詞的錄音檔名
 *     category: '動物',         // 用來讓干擾選項盡量抽同類別
 *   }
 *
 * 兩種用法：
 *
 * 1) 不分階層、單純隨機出題（適合單字庫還很小、或不想分階段時）：
 *      const q = IndigenousQuiz.generateQuestion(words);
 *
 * 2) 分階層解鎖出題（跟 quiz-engine.js 的關卡系統同一種節奏：
 *    每次先開放前 5 個詞，5 個都答對才解鎖下 5 個；答錯的詞會在 2~4 題後重新出現）：
 *      const tier = IndigenousQuiz.createTierState();   // 新玩家；舊存檔則整包還原回來
 *      const q = IndigenousQuiz.pickTieredQuestion(tier, words);
 *      // ……玩家作答後……
 *      IndigenousQuiz.recordTieredAnswer(tier, words, q.correctId, {
 *        correct: true,
 *        isFirstAttempt: true,  // 這是不是這題「第一次」作答
 *        isFinal: true,         // 這次結果是否已經確定，不會再有重答機會
 *      });
 *      // 存檔時把 tier 整包（含 JSON.stringify）存進遊戲自己的存檔即可
 *
 * q.options[i].audio 若非 null，表示這個選項應該可以播放語音。
 * ────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 干擾選項：優先抽同類別；同類別詞彙不夠時，自動往其他類別補滿，
  // 確保單字庫某些類別詞彙偏少時，出題也不會卡住或報錯。
  function pickDistractors(words, correct, count) {
    count = count || 3;
    const others = words.filter(w => w.id !== correct.id);
    const sameCat = shuffle(others.filter(w => w.category === correct.category));
    let picked = sameCat.slice(0, count);
    if (picked.length < count) {
      const rest = shuffle(others.filter(w => w.category !== correct.category));
      picked = picked.concat(rest.slice(0, count - picked.length));
    }
    return picked;
  }

  function _buildQuestion(candidatePool, correct, type) {
    const distractors = pickDistractors(candidatePool, correct, 3);
    if (distractors.length < 3) return null;
    const optionWords = shuffle([correct, ...distractors]);

    if (type === 'meaning2spelling') {
      return {
        type,
        promptText: `哪一個的意思是「${correct.meaning}」？`,
        promptAudio: null, // 題目是中文，交給既有中文 TTS 唸即可
        correctId: correct.id,
        options: optionWords.map(w => ({ id: w.id, label: w.spelling, audio: w.audio || null })),
      };
    }
    return {
      type,
      promptText: correct.spelling,
      promptAudio: correct.audio || null, // 題目本身要播放這個詞的錄音
      correctId: correct.id,
      options: optionWords.map(w => ({ id: w.id, label: w.meaning, audio: null })),
    };
  }

  // 產生一題，不分階層、從整個單字庫隨機抽（適合還沒接階層系統時用）。
  // type 省略時隨機挑：
  //   'meaning2spelling' → 題目顯示中文意思，選項是拼音（附語音）
  //   'spelling2meaning' → 題目播放／顯示拼音語音，選項是中文意思
  function generateQuestion(words, type) {
    type = type || (Math.random() < 0.5 ? 'meaning2spelling' : 'spelling2meaning');
    const pool = (words || []).filter(w => w && w.meaning && w.spelling && w.id != null);
    if (pool.length < 4) return null; // 單字庫不足 4 個完整詞，無法湊出 4 選項
    const correct = pool[Math.floor(Math.random() * pool.length)];
    return _buildQuestion(pool, correct, type);
  }

  /* ── 階層解鎖（比照 quiz-engine.js 的 tier 機制，但獨立實作，不依賴它）──
     words 依 id（辭典順序）排序後，每次只開放「目前解鎖到第幾個」以內的詞，
     解鎖範圍內的詞全部答對過一輪，才會一次開放下 5 個；答錯的詞會排入
     retryQueue，2~4 題後重新出現，而且不管有沒有在本批待通過清單內都會排。
  */
  function _pool(words) {
    return (words || [])
      .filter(w => w && w.meaning && w.spelling && w.id != null)
      .slice()
      .sort((a, b) => a.id - b.id);
  }

  function createTierState() {
    return { unlockedMax: null, pendingIds: null, retryQueue: [] };
  }

  function _recomputePending(state, pool) {
    const lower = Math.max(1, state.unlockedMax - 4);
    state.pendingIds = pool.filter(w => w.id >= lower && w.id <= state.unlockedMax).map(w => w.id);
  }

  // 只會初始化一次；historicalCorrect 可以讓「之前用舊的隨機出題方式已經答對過一些題」的
  // 玩家不用整個從頭來過，直接換算一個合理的起始解鎖範圍。
  function ensureTierState(state, words, historicalCorrect) {
    if (state.unlockedMax != null) return;
    const pool = _pool(words);
    const maxId = pool.length ? pool[pool.length - 1].id : 0;
    const correct = historicalCorrect || 0;
    state.unlockedMax = pool.length ? Math.min(maxId, Math.max(5, 5 + 5 * Math.floor(correct / 30))) : 5;
    state.retryQueue = state.retryQueue || [];
    _recomputePending(state, pool);
  }

  function advanceTier(state, words) {
    const pool = _pool(words);
    const maxId = pool.length ? pool[pool.length - 1].id : 0;
    if (state.unlockedMax >= maxId) { state.pendingIds = []; return; }
    state.unlockedMax = Math.min(maxId, state.unlockedMax + 5);
    _recomputePending(state, pool);
  }

  // 答對某個 id 時呼叫：從待通過清單移除，全部通過後自動晉級（解鎖下一批 5 個）
  function onTierCorrect(state, id, words) {
    if (!state || !Array.isArray(state.pendingIds) || id == null) return;
    const idx = state.pendingIds.indexOf(id);
    if (idx === -1) return; // 不在本批門檻內（複習舊詞），不影響解鎖進度
    state.pendingIds.splice(idx, 1);
    if (state.pendingIds.length === 0) advanceTier(state, words);
  }

  // 確定答錯（沒有重答機會了）時呼叫：安排隨機 2~4 題後重新出現
  function scheduleRetry(state, id) {
    if (!state || id == null) return;
    if (state.retryQueue.some(e => e.id === id)) return;
    const wait = 2 + Math.floor(Math.random() * 3);
    state.retryQueue.push({ id, wait });
  }

  // 依目前解鎖進度出一題：到期的複習題優先；否則從「目前解鎖範圍內」抽一個詞當正解，
  // 干擾選項也只從同一個解鎖範圍內抽，不會冒出完全沒學過的詞當選項。
  // 範圍內詞彙還不夠 4 個時（剛開始、單字庫還很小），才會 fallback 用整個題庫湊題。
  function pickTieredQuestion(state, words, type) {
    const pool = _pool(words);
    if (pool.length === 0) return null;
    ensureTierState(state, words);

    if (state.retryQueue.length) {
      state.retryQueue.forEach(e => e.wait--);
      const dueIdx = state.retryQueue.findIndex(e => e.wait <= 0);
      if (dueIdx >= 0) {
        const due = state.retryQueue.splice(dueIdx, 1)[0];
        const correct = pool.find(w => w.id === due.id);
        if (correct) {
          const upper = Math.min(state.unlockedMax, pool[pool.length - 1].id);
          const candidates = pool.filter(w => w.id <= upper);
          return _buildQuestion(candidates.length >= 4 ? candidates : pool, correct, type || (Math.random() < 0.5 ? 'meaning2spelling' : 'spelling2meaning'));
        }
      }
    }

    const maxId = pool[pool.length - 1].id;
    const upper = Math.min(state.unlockedMax, maxId);
    const candidates = pool.filter(w => w.id <= upper);
    const usable = candidates.length >= 4 ? candidates : pool;
    const correct = usable[Math.floor(Math.random() * usable.length)];
    return _buildQuestion(usable, correct, type || (Math.random() < 0.5 ? 'meaning2spelling' : 'spelling2meaning'));
  }

  // 作答結果回報，介面比照 QuizEngine.recordAnswer：
  // result = { correct, isFirstAttempt, isFinal }
  function recordTieredAnswer(state, words, testedId, result) {
    if (result.correct) {
      onTierCorrect(state, testedId, words);
    } else if (result.isFinal) {
      scheduleRetry(state, testedId);
    }
  }

  global.IndigenousQuiz = {
    pickDistractors, generateQuestion,
    createTierState, ensureTierState, pickTieredQuestion, recordTieredAnswer,
    advanceTier, onTierCorrect, scheduleRetry, // 進階／個別使用（一般情況下用 pickTieredQuestion + recordTieredAnswer 就夠了）
  };

})(typeof window !== 'undefined' ? window : globalThis);

