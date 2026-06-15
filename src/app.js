(() => {
  'use strict';

  const LS_KEY = 'inquiryPracticeReportPlatform.v2';
  const STUDENT_ID_KEY = 'inquiryPracticeReportPlatform.studentIdentity.v1';
  const DEFAULT_GROUP_COUNT = 9;
  const PHASE_LABEL = { setup: '設定中', report: '報告時間', question: '提問時間', rating: '評分／換場時間', done: '已完成' };
  const DURATION = { report: 300, question: 180, rating: 180 };
  const REPORT_CRITERIA = [
    {
      key: 'inquiryDesign',
      short: '問題與方法',
      label: '探究問題與方法設計',
      description: '問題意識、變因控制、方法合理性',
      avgId: 'reportInquiryAvg',
    },
    {
      key: 'evidenceAnalysis',
      short: '證據與分析',
      label: '資料證據與分析解釋',
      description: '數據品質、圖表呈現、證據支持結論',
      avgId: 'reportEvidenceAvg',
    },
    {
      key: 'communication',
      short: '表達與回應',
      label: '科學表達與回應能力',
      description: '結構清楚、時間掌握、回應提問',
      avgId: 'reportCommunicationAvg',
    },
  ];

  const $ = (id) => document.getElementById(id);
  const isStudentMode = new URLSearchParams(location.search).has('session');
  const now = () => Date.now();
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const safeText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const makeDefaultGroups = (count) => Array.from({ length: count }, (_, i) => `第${i + 1}組`);

  let state = loadState();
  let teacherPeer = null;
  let teacherConnections = new Map();
  let studentPeer = null;
  let studentConn = null;
  let studentState = null;
  let savedStudentGroup = '';
  let lastDoneKey = '';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function defaultState() {
    const groups = makeDefaultGroups(DEFAULT_GROUP_COUNT);
    const [reportOrder, questionOrder] = makeDerangedOrders(groups);
    return {
      schemaVersion: 2,
      title: '探究與實作期末報告',
      groups,
      reportOrder,
      questionOrder,
      currentIndex: 0,
      phase: 'setup',
      timer: { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null },
      scores: {},
      updatedAt: new Date().toISOString(),
    };
  }

  function loadState() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      return normalizeLoadedState(parsed, base);
    } catch (_) {
      return base;
    }
  }

  function normalizeLoadedState(parsed, base = defaultState()) {
    const groups = Array.isArray(parsed.groups) && parsed.groups.length >= 2 ? parsed.groups.map(safeText).filter(Boolean) : base.groups;
    let reportOrder = Array.isArray(parsed.reportOrder) ? parsed.reportOrder.map(safeText).filter(Boolean) : [];
    let questionOrder = Array.isArray(parsed.questionOrder) ? parsed.questionOrder.map(safeText).filter(Boolean) : [];
    const orderLooksValid = reportOrder.length === groups.length && questionOrder.length === groups.length && groups.every((g) => reportOrder.includes(g) && questionOrder.includes(g));
    if (!orderLooksValid) [reportOrder, questionOrder] = makeDerangedOrders(groups);
    return {
      ...base,
      ...parsed,
      schemaVersion: 2,
      groups,
      reportOrder,
      questionOrder,
      currentIndex: clamp(Number(parsed.currentIndex || 0), 0, Math.max(0, groups.length - 1)),
      timer: parsed.timer || base.timer,
      scores: parsed.scores || {},
    };
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  function parseGroups(raw) {
    const seen = new Set();
    return String(raw || '')
      .split(/[\n,，、;；]+/)
      .map(safeText)
      .filter(Boolean)
      .filter((g) => (seen.has(g) ? false : (seen.add(g), true)));
  }

  function randomShuffle(arr) {
    const out = arr.slice();
    const bytes = new Uint32Array(out.length || 1);
    crypto.getRandomValues(bytes);
    for (let i = out.length - 1; i > 0; i--) {
      const j = bytes[i] % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function makeDerangedOrders(groups) {
    const report = randomShuffle(groups);
    if (groups.length < 2) return [report, report.slice()];
    for (let i = 0; i < 500; i++) {
      const question = randomShuffle(groups);
      if (question.every((g, idx) => g !== report[idx])) return [report, question];
    }
    return [report, report.slice(1).concat(report[0])];
  }

  function currentRound(s = state) {
    const total = Math.min(s.reportOrder?.length || 0, s.questionOrder?.length || 0);
    if (!total) return { index: 0, roundNo: 0, total: 0, reportGroup: null, questionGroup: null };
    const index = clamp(Number(s.currentIndex || 0), 0, total - 1);
    return { index, roundNo: index + 1, total, reportGroup: s.reportOrder[index], questionGroup: s.questionOrder[index] };
  }

  function timerView(s = state) {
    const t = s.timer || {};
    let remaining = Number(t.duration || 0);
    let done = false;
    if (t.running && t.endsAt) {
      remaining = Math.max(0, Math.ceil((t.endsAt - now()) / 1000));
      done = remaining <= 0;
    }
    return { ...t, remaining, done, label: PHASE_LABEL[t.phase || s.phase] || '設定中' };
  }

  function expectedScorers(roundIndex, s = state) {
    const report = s.reportOrder?.[roundIndex];
    const question = s.questionOrder?.[roundIndex];
    return (s.groups || []).filter((g) => g !== report && g !== question);
  }

  function validScore(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 && n <= 10;
  }

  function avg(values) {
    const nums = values.map(Number).filter(Number.isFinite);
    return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
  }

  function scoreText(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function normalizeScoreRecord(entryKey, record = {}) {
    const keyGroup = safeText(String(entryKey).split('::')[0]);
    const scorerGroup = safeText(record.scorerGroup) || keyGroup;
    const seatNo = safeText(record.seatNo);
    const reportScores = {};
    for (const criterion of REPORT_CRITERIA) {
      const raw = record.reportScores?.[criterion.key];
      if (validScore(raw)) reportScores[criterion.key] = Number(raw);
      else if (validScore(record.reportScore)) reportScores[criterion.key] = Number(record.reportScore);
    }
    return {
      ...record,
      scorerGroup,
      seatNo,
      reportScores,
      reportScore: avg(REPORT_CRITERIA.map((c) => reportScores[c.key])),
      questionScore: validScore(record.questionScore) ? Number(record.questionScore) : null,
    };
  }

  function roundRecords(roundIndex, s = state) {
    return Object.entries(s.scores?.[roundIndex] || {}).map(([entryKey, record]) => normalizeScoreRecord(entryKey, record));
  }

  function roundStats(roundIndex, s = state) {
    const records = roundRecords(roundIndex, s);
    const submittedGroups = new Set(records.map((r) => r.scorerGroup).filter(Boolean));
    const missing = expectedScorers(roundIndex, s).filter((g) => !submittedGroups.has(g));
    const criteriaAvgs = {};
    for (const criterion of REPORT_CRITERIA) {
      criteriaAvgs[criterion.key] = avg(records.map((r) => r.reportScores?.[criterion.key]));
    }
    return {
      roundNo: roundIndex + 1,
      reportGroup: s.reportOrder?.[roundIndex] || '',
      questionGroup: s.questionOrder?.[roundIndex] || '',
      reportAvg: avg(records.map((r) => r.reportScore)),
      reportCriteriaAvgs: criteriaAvgs,
      questionAvg: avg(records.map((r) => r.questionScore)),
      responseCount: records.length,
      submittedGroupCount: submittedGroups.size,
      expectedCount: expectedScorers(roundIndex, s).length,
      missingGroups: missing,
    };
  }

  function publicState() {
    return {
      title: state.title,
      groups: state.groups,
      reportOrder: state.reportOrder,
      questionOrder: state.questionOrder,
      currentIndex: state.currentIndex,
      phase: state.phase,
      phaseLabel: PHASE_LABEL[state.phase] || '設定中',
      timer: timerView(state),
      currentRound: currentRound(state),
      reportCriteria: REPORT_CRITERIA.map(({ key, short, label, description }) => ({ key, short, label, description })),
      updatedAt: state.updatedAt,
    };
  }

  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }

  function bell() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.22, 0.44].forEach((delay) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.32, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.18);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + 0.2);
      });
    } catch (e) { console.warn(e); }
  }

  function startPhase(phase, duration) {
    state.phase = phase;
    state.timer = { running: true, phase, duration, startedAt: now(), endsAt: now() + duration * 1000 };
    saveState();
    renderTeacher();
    broadcastState();
    bell();
  }

  function updateGroupCountHint() {
    const groups = parseGroups($('groupsInput')?.value || '');
    const count = groups.length || state.groups.length || 0;
    if ($('groupCountHint')) $('groupCountHint').textContent = `目前 ${count} 組`;
    if ($('groupCountInput') && document.activeElement !== $('groupCountInput')) $('groupCountInput').value = count;
  }

  function setupTeacher() {
    $('teacherApp').classList.remove('hidden');
    $('titleInput').value = state.title;
    $('groupsInput').value = state.groups.join('\n');
    $('groupCountInput').value = state.groups.length;
    updateGroupCountHint();

    $('groupsInput').addEventListener('input', updateGroupCountHint);
    $('applyGroupCountBtn').onclick = () => {
      const count = clamp(Math.floor(Number($('groupCountInput').value) || DEFAULT_GROUP_COUNT), 2, 50);
      $('groupCountInput').value = count;
      $('groupsInput').value = makeDefaultGroups(count).join('\n');
      updateGroupCountHint();
    };
    $('saveShuffleBtn').onclick = () => {
      const groups = parseGroups($('groupsInput').value);
      if (groups.length < 2) return alert('至少需要 2 個組別。');
      const [reportOrder, questionOrder] = makeDerangedOrders(groups);
      state = { ...state, schemaVersion: 2, title: safeText($('titleInput').value) || '探究與實作期末報告', groups, reportOrder, questionOrder, currentIndex: 0, scores: {}, phase: 'setup', timer: { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null } };
      saveState(); renderTeacher(); broadcastState();
    };
    $('reshuffleBtn').onclick = () => {
      const groups = parseGroups($('groupsInput').value);
      if (groups.length < 2) return alert('至少需要 2 個組別。');
      const [reportOrder, questionOrder] = makeDerangedOrders(groups);
      state.groups = groups;
      state.reportOrder = reportOrder; state.questionOrder = questionOrder; state.currentIndex = 0; state.scores = {}; state.phase = 'setup';
      state.timer = { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null };
      saveState(); renderTeacher(); broadcastState();
    };
    $('resetScoresBtn').onclick = () => {
      if (confirm('確定要清空所有評分資料？')) { state.scores = {}; saveState(); renderTeacher(); broadcastState(); }
    };
    $('startSessionBtn').onclick = startTeacherSession;
    $('copyStudentUrlBtn').onclick = async () => {
      const text = $('studentUrl').textContent;
      try { await navigator.clipboard.writeText(text); alert('已複製學生網址'); } catch (_) { prompt('請複製學生網址', text); }
    };
    $('startReportBtn').onclick = () => startPhase('report', DURATION.report);
    $('startQuestionBtn').onclick = () => startPhase('question', DURATION.question);
    $('startRatingBtn').onclick = () => startPhase('rating', DURATION.rating);
    $('nextRoundBtn').onclick = () => {
      const cr = currentRound();
      if (cr.total && cr.index < cr.total - 1) { state.currentIndex = cr.index + 1; startPhase('report', DURATION.report); }
      else { state.phase = 'done'; state.timer = { running: false, phase: 'done', duration: 0, startedAt: null, endsAt: null }; saveState(); renderTeacher(); broadcastState(); alert('已到最後一輪。'); }
    };
    $('exportXlsxBtn').onclick = exportXlsx;
    $('exportJsonBtn').onclick = exportJson;
    $('importJsonInput').onchange = importJson;
    renderTeacher();
    setInterval(() => { renderTeacher(false); }, 1000);
  }

  function startTeacherSession() {
    if (!window.Peer) return alert('PeerJS 尚未載入，請確認網路可連到 CDN。');
    if (teacherPeer && !teacherPeer.destroyed) return;
    $('sessionStatus').textContent = '建立中…';
    teacherPeer = new Peer(undefined, { debug: 1 });
    teacherPeer.on('open', (id) => {
      $('sessionStatus').textContent = `已建立：${id}`;
      updateStudentUrl(id);
      renderTeacher(false);
    });
    teacherPeer.on('connection', setupTeacherConnection);
    teacherPeer.on('error', (err) => {
      $('sessionStatus').textContent = `連線錯誤：${err.type || err.message}`;
      console.error(err);
    });
  }

  function setupTeacherConnection(conn) {
    teacherConnections.set(conn.peer, conn);
    conn.on('open', () => sendState(conn));
    conn.on('data', (msg) => handleTeacherMessage(conn, msg));
    conn.on('close', () => { teacherConnections.delete(conn.peer); renderTeacher(false); });
    conn.on('error', () => { teacherConnections.delete(conn.peer); renderTeacher(false); });
    renderTeacher(false);
  }

  function handleTeacherMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello' || msg.type === 'request_state') return sendState(conn);
    if (msg.type !== 'score') return;
    const p = msg.payload || {};
    const idx = Number(p.roundIndex);
    const scorerGroup = safeText(p.scorerGroup);
    const seatNo = safeText(p.seatNo);
    const reportScores = {};
    for (const criterion of REPORT_CRITERIA) reportScores[criterion.key] = Number(p.reportScores?.[criterion.key]);
    const questionScore = Number(p.questionScore);
    const cr = currentRound();
    if (idx < 0 || idx >= cr.total) return conn.send({ type: 'error', message: '輪次錯誤，請重新整理。' });
    if (!state.groups.includes(scorerGroup)) return conn.send({ type: 'error', message: '請選擇有效組別。' });
    if (!seatNo) return conn.send({ type: 'error', message: '請填寫座號。' });
    if (seatNo.length > 12) return conn.send({ type: 'error', message: '座號太長，請填 1–12 個字元。' });
    if ([state.reportOrder[idx], state.questionOrder[idx]].includes(scorerGroup)) return conn.send({ type: 'error', message: '本輪報告組與提問組不需評分。' });
    if (!REPORT_CRITERIA.every((c) => validScore(reportScores[c.key])) || !validScore(questionScore)) return conn.send({ type: 'error', message: '分數必須都是 1–10。' });
    state.scores[idx] = state.scores[idx] || {};
    const recordKey = `${scorerGroup}::${seatNo}`;
    state.scores[idx][recordKey] = {
      scorerGroup,
      seatNo,
      reportScores,
      reportScore: avg(REPORT_CRITERIA.map((c) => reportScores[c.key])),
      questionScore,
      comment: safeText(p.comment),
      submittedAt: new Date().toISOString(),
      peer: conn.peer,
    };
    saveState();
    conn.send({ type: 'ack', message: '已送出／更新本輪評分。' });
    renderTeacher();
    broadcastState();
  }

  function sendState(conn) { try { conn.send({ type: 'state', state: publicState() }); } catch (e) { console.warn(e); } }
  function broadcastState() { for (const conn of teacherConnections.values()) sendState(conn); }

  function updateStudentUrl(peerId) {
    const url = new URL(location.href);
    url.search = `?session=${encodeURIComponent(peerId)}`;
    url.hash = '';
    $('studentUrl').textContent = url.toString();
    if (window.QRious) {
      new QRious({ element: $('qrCanvas'), value: url.toString(), size: 220, padding: 8, level: 'M' });
    }
  }

  function renderTeacher(updateInputs = true) {
    if (updateInputs && document.activeElement !== $('titleInput')) $('titleInput').value = state.title;
    if (updateInputs && document.activeElement !== $('groupsInput')) $('groupsInput').value = state.groups.join('\n');
    updateGroupCountHint();
    const cr = currentRound(); const tv = timerView();
    $('roundInfo').textContent = cr.total ? `第 ${cr.roundNo} / ${cr.total} 輪` : '尚未抽籤';
    $('phaseLabel').textContent = tv.label;
    $('timerText').textContent = mmss(tv.remaining);
    $('timerBar').style.width = tv.duration ? `${clamp(100 * (1 - tv.remaining / tv.duration), 0, 100)}%` : '0%';
    $('reportGroup').textContent = cr.reportGroup || '—';
    $('questionGroup').textContent = cr.questionGroup || '—';
    $('connectionCount').textContent = String(teacherConnections.size);
    if (tv.running && tv.done) {
      const key = `${tv.phase}:${tv.endsAt}`;
      if (key !== lastDoneKey) { lastDoneKey = key; bell(); }
    }
    const cs = cr.total ? roundStats(cr.index) : null;
    $('reportAvg').textContent = scoreText(cs?.reportAvg);
    $('questionAvg').textContent = scoreText(cs?.questionAvg);
    for (const criterion of REPORT_CRITERIA) $(criterion.avgId).textContent = scoreText(cs?.reportCriteriaAvgs?.[criterion.key]);
    $('scoreCount').textContent = cs ? `${cs.responseCount}人 / ${cs.submittedGroupCount}/${cs.expectedCount}組` : '0人 / 0組';
    $('missingGroups').textContent = `未評分組別：${cs?.missingGroups?.join('、') || '—'}`;
    renderOrderTable(); renderStatsTable();
  }

  function renderRows(tableId, rows) {
    $(tableId).innerHTML = rows.map((r, i) => `<tr>${r.map((c) => i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`).join('')}</tr>`).join('');
  }

  function renderOrderTable() {
    const rows = [['順位', '上台報告', '負責提問', '檢查']];
    const total = Math.min(state.reportOrder.length, state.questionOrder.length);
    for (let i = 0; i < total; i++) rows.push([i + 1, state.reportOrder[i], state.questionOrder[i], state.reportOrder[i] === state.questionOrder[i] ? '衝突' : 'OK']);
    $('orderTable').innerHTML = rows.map((r, i) => `<tr class="${i && r[3] !== 'OK' ? 'conflict' : ''}">${r.map((c) => i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`).join('')}</tr>`).join('');
  }

  function renderStatsTable() {
    const total = Math.min(state.reportOrder.length, state.questionOrder.length);
    const rows = [['順位', '報告組', '提問組', '報告總平均', '問題與方法', '證據與分析', '表達與回應', '提問平均', '評分進度', '未評分']];
    for (let i = 0; i < total; i++) {
      const s = roundStats(i);
      rows.push([
        s.roundNo,
        s.reportGroup,
        s.questionGroup,
        scoreText(s.reportAvg),
        scoreText(s.reportCriteriaAvgs.inquiryDesign),
        scoreText(s.reportCriteriaAvgs.evidenceAnalysis),
        scoreText(s.reportCriteriaAvgs.communication),
        scoreText(s.questionAvg),
        `${s.responseCount}人 / ${s.submittedGroupCount}/${s.expectedCount}組`,
        s.missingGroups.join('、') || '—',
      ]);
    }
    renderRows('statsTable', rows);
  }

  function exportRows() {
    const total = Math.min(state.reportOrder.length, state.questionOrder.length);
    const summary = [[state.title], ['匯出時間', new Date().toLocaleString()], [], ['順位', '報告組別', '提問組別', '報告總平均', '探究問題與方法設計', '資料證據與分析解釋', '科學表達與回應能力', '提問平均', '評分人數', '已評分組數', '應評分組數', '未評分組別']];
    for (let i = 0; i < total; i++) {
      const s = roundStats(i);
      summary.push([s.roundNo, s.reportGroup, s.questionGroup, s.reportAvg, s.reportCriteriaAvgs.inquiryDesign, s.reportCriteriaAvgs.evidenceAnalysis, s.reportCriteriaAvgs.communication, s.questionAvg, s.responseCount, s.submittedGroupCount, s.expectedCount, s.missingGroups.join('、')]);
    }
    const groupSummary = [['組別', '報告順位', '報告總平均', '探究問題與方法設計', '資料證據與分析解釋', '科學表達與回應能力', '提問順位', '提問平均']];
    for (const g of state.groups) {
      const ri = state.reportOrder.indexOf(g); const qi = state.questionOrder.indexOf(g);
      const rs = ri >= 0 ? roundStats(ri) : null;
      const qs = qi >= 0 ? roundStats(qi) : null;
      groupSummary.push([g, ri >= 0 ? ri + 1 : '', rs?.reportAvg ?? '', rs?.reportCriteriaAvgs?.inquiryDesign ?? '', rs?.reportCriteriaAvgs?.evidenceAnalysis ?? '', rs?.reportCriteriaAvgs?.communication ?? '', qi >= 0 ? qi + 1 : '', qs?.questionAvg ?? '']);
    }
    const raw = [['順位', '報告組別', '提問組別', '評分組別', '評分者座號', '探究問題與方法設計', '資料證據與分析解釋', '科學表達與回應能力', '報告總平均', '提問分數', '送出時間', '備註']];
    for (let i = 0; i < total; i++) {
      for (const r of roundRecords(i)) {
        raw.push([i + 1, state.reportOrder[i], state.questionOrder[i], r.scorerGroup, r.seatNo, r.reportScores.inquiryDesign, r.reportScores.evidenceAnalysis, r.reportScores.communication, r.reportScore, r.questionScore, r.submittedAt, r.comment || '']);
      }
    }
    const order = [['順位', '報告組別', '提問組別', '是否衝突']];
    for (let i = 0; i < total; i++) order.push([i + 1, state.reportOrder[i], state.questionOrder[i], state.reportOrder[i] === state.questionOrder[i] ? '衝突' : 'OK']);
    return { summary, groupSummary, raw, order };
  }

  function exportXlsx() {
    const filename = `${state.title || '探究與實作期末報告'}_評分資料_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.xlsx`;
    if (!window.XLSX) { alert('Excel 套件尚未載入，請確認網路。'); return; }
    const rows = exportRows();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.summary), '總表');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.groupSummary), '組別總結');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.raw), '原始評分');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.order), '抽籤排序');
    XLSX.writeFile(wb, filename);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.title || '探究與實作期末報告'}_備份.json`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  function importJson(ev) {
    const file = ev.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { state = normalizeLoadedState(JSON.parse(reader.result)); saveState(); renderTeacher(); broadcastState(); alert('已匯入備份。'); }
      catch (e) { alert('匯入失敗：' + e.message); }
    };
    reader.readAsText(file, 'utf-8');
  }

  function setupStudent() {
    $('studentApp').classList.remove('hidden');
    try {
      const saved = JSON.parse(localStorage.getItem(STUDENT_ID_KEY) || '{}');
      savedStudentGroup = safeText(saved.group);
      $('studentSeatNo').value = safeText(saved.seatNo);
    } catch (_) {}
    for (const criterion of REPORT_CRITERIA) {
      const input = $(`studentReport_${criterion.key}`);
      const text = $(`studentReport_${criterion.key}_Text`);
      input.oninput = () => { text.textContent = input.value; };
    }
    $('studentQuestionScore').oninput = () => $('studentQuestionScoreText').textContent = $('studentQuestionScore').value;
    $('studentGroupSelect').onchange = renderStudentEligibility;
    $('studentSeatNo').addEventListener('input', renderStudentEligibility);
    $('submitScoreBtn').onclick = submitStudentScore;
    const session = new URLSearchParams(location.search).get('session');
    if (!session) { $('studentConn').textContent = '缺少 session'; return; }
    if (!window.Peer) { $('studentConn').textContent = 'PeerJS 尚未載入'; return; }
    studentPeer = new Peer(undefined, { debug: 0 });
    studentPeer.on('open', () => {
      studentConn = studentPeer.connect(session, { reliable: true });
      studentConn.on('open', () => { $('studentConn').textContent = '已連線'; studentConn.send({ type: 'hello' }); });
      studentConn.on('data', handleStudentMessage);
      studentConn.on('close', () => $('studentConn').textContent = '連線已中斷，請重新掃 QR');
      studentConn.on('error', () => $('studentConn').textContent = '連線錯誤，請重新整理');
    });
    studentPeer.on('error', (err) => { $('studentConn').textContent = `連線錯誤：${err.type || err.message}`; });
    setInterval(() => { if (studentConn?.open) studentConn.send({ type: 'request_state' }); renderStudent(); }, 2000);
  }

  function handleStudentMessage(msg) {
    if (msg.type === 'state') { studentState = msg.state; renderStudent(); }
    if (msg.type === 'ack') { $('submitMsg').textContent = msg.message || '已送出。'; $('submitMsg').style.color = 'var(--success)'; }
    if (msg.type === 'error') { $('submitMsg').textContent = msg.message || '送出失敗。'; $('submitMsg').style.color = 'var(--danger)'; }
  }

  function renderStudent() {
    if (!studentState) return;
    $('studentTitle').textContent = studentState.title || '探究與實作期末報告';
    const cr = studentState.currentRound || {};
    $('studentRoundInfo').textContent = cr.total ? `第 ${cr.roundNo} / ${cr.total} 輪｜${studentState.timer?.label || ''}｜剩餘 ${mmss(studentState.timer?.remaining || 0)}` : '尚未開始';
    $('studentReportGroup').textContent = cr.reportGroup || '—';
    $('studentQuestionGroup').textContent = cr.questionGroup || '—';
    const old = $('studentGroupSelect').value || savedStudentGroup;
    $('studentGroupSelect').innerHTML = '<option value="">請選擇你的組別</option>' + (studentState.groups || []).map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
    if (old) $('studentGroupSelect').value = old;
    renderStudentEligibility();
  }

  function renderStudentEligibility() {
    const g = $('studentGroupSelect').value;
    const seatNo = safeText($('studentSeatNo').value);
    const cr = studentState?.currentRound || {};
    const msg = $('eligibilityMsg');
    const btn = $('submitScoreBtn');
    if (!g || !seatNo) { msg.className = 'notice mini'; msg.textContent = '請先選擇你的組別並填寫座號。'; btn.disabled = true; return; }
    if (g === cr.reportGroup) { msg.className = 'notice mini bad'; msg.textContent = '你們本輪是上台報告組，不需要評分。'; btn.disabled = true; return; }
    if (g === cr.questionGroup) { msg.className = 'notice mini bad'; msg.textContent = '你們本輪是負責提問組，不需要評分。'; btn.disabled = true; return; }
    msg.className = 'notice mini ok'; msg.textContent = '你們本輪是聽講評分組，請評分報告組三項能力與提問組問題品質。'; btn.disabled = false;
  }

  function submitStudentScore() {
    if (!studentConn?.open) return alert('尚未連線到老師端，請重新整理或重新掃 QR。');
    const scorerGroup = $('studentGroupSelect').value;
    const seatNo = safeText($('studentSeatNo').value);
    if (!scorerGroup) return alert('請選擇你的組別。');
    if (!seatNo) return alert('請填寫你的座號。');
    const reportScores = {};
    for (const criterion of REPORT_CRITERIA) reportScores[criterion.key] = Number($(`studentReport_${criterion.key}`).value);
    const cr = studentState.currentRound;
    savedStudentGroup = scorerGroup;
    localStorage.setItem(STUDENT_ID_KEY, JSON.stringify({ group: scorerGroup, seatNo }));
    studentConn.send({ type: 'score', payload: { roundIndex: cr.index, scorerGroup, seatNo, reportScores, questionScore: Number($('studentQuestionScore').value), comment: $('studentComment').value } });
    $('submitMsg').textContent = '送出中…'; $('submitMsg').style.color = 'var(--muted)';
  }

  window.addEventListener('DOMContentLoaded', () => {
    if (isStudentMode) setupStudent(); else setupTeacher();
  });
})();
