(() => {
  'use strict';

  const LS_KEY = 'inquiryPracticeReportPlatform.v1';
  const DEFAULT_GROUPS = Array.from({ length: 8 }, (_, i) => `第${i + 1}組`);
  const PHASE_LABEL = { setup: '設定中', report: '報告時間', question: '提問時間', rating: '評分／換場時間', done: '已完成' };
  const DURATION = { report: 300, question: 180, rating: 180 };

  const $ = (id) => document.getElementById(id);
  const isStudentMode = new URLSearchParams(location.search).has('session');
  const now = () => Date.now();
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const safeText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

  let state = loadState();
  let teacherPeer = null;
  let teacherConnections = new Map();
  let studentPeer = null;
  let studentConn = null;
  let studentState = null;
  let lastDoneKey = '';

  function defaultState() {
    const [reportOrder, questionOrder] = makeDerangedOrders(DEFAULT_GROUPS);
    return {
      title: '探究與實作期末報告',
      groups: DEFAULT_GROUPS,
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
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return { ...defaultState(), ...parsed, timer: parsed.timer || defaultState().timer };
    } catch (_) {
      return defaultState();
    }
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

  function roundStats(roundIndex, s = state) {
    const rows = Object.entries(s.scores?.[roundIndex] || {});
    const reportScores = rows.map(([, v]) => Number(v.reportScore)).filter(Number.isFinite);
    const questionScores = rows.map(([, v]) => Number(v.questionScore)).filter(Number.isFinite);
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
    const submitted = new Set(rows.map(([g]) => g));
    const missing = expectedScorers(roundIndex, s).filter((g) => !submitted.has(g));
    return {
      roundNo: roundIndex + 1,
      reportGroup: s.reportOrder?.[roundIndex] || '',
      questionGroup: s.questionOrder?.[roundIndex] || '',
      reportAvg: avg(reportScores),
      questionAvg: avg(questionScores),
      count: rows.length,
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
      updatedAt: state.updatedAt,
    };
  }

  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }

  function toast(msg) {
    console.log(msg);
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
    bell(); // unlock audio on teacher click
  }

  function setupTeacher() {
    $('teacherApp').classList.remove('hidden');
    $('titleInput').value = state.title;
    $('groupsInput').value = state.groups.join('\n');
    $('saveShuffleBtn').onclick = () => {
      const groups = parseGroups($('groupsInput').value);
      if (groups.length < 2) return alert('至少需要 2 個組別。');
      const [reportOrder, questionOrder] = makeDerangedOrders(groups);
      state = { ...state, title: safeText($('titleInput').value) || '探究與實作期末報告', groups, reportOrder, questionOrder, currentIndex: 0, scores: {}, phase: 'setup', timer: { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null } };
      saveState(); renderTeacher(); broadcastState();
    };
    $('reshuffleBtn').onclick = () => {
      const [reportOrder, questionOrder] = makeDerangedOrders(state.groups);
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
    const scorer = safeText(p.scorerGroup);
    const reportScore = Number(p.reportScore);
    const questionScore = Number(p.questionScore);
    const cr = currentRound();
    if (idx < 0 || idx >= cr.total) return conn.send({ type: 'error', message: '輪次錯誤，請重新整理。' });
    if (!state.groups.includes(scorer)) return conn.send({ type: 'error', message: '請選擇有效組別。' });
    if ([state.reportOrder[idx], state.questionOrder[idx]].includes(scorer)) return conn.send({ type: 'error', message: '本輪報告組與提問組不需評分。' });
    if (!(reportScore >= 1 && reportScore <= 10 && questionScore >= 1 && questionScore <= 10)) return conn.send({ type: 'error', message: '分數必須是 1–10。' });
    state.scores[idx] = state.scores[idx] || {};
    state.scores[idx][scorer] = { reportScore, questionScore, comment: safeText(p.comment), submittedAt: new Date().toISOString(), peer: conn.peer };
    saveState();
    conn.send({ type: 'ack', message: '已送出／更新評分。' });
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
    $('reportAvg').textContent = cs?.reportAvg ?? '—';
    $('questionAvg').textContent = cs?.questionAvg ?? '—';
    $('scoreCount').textContent = cs ? `${cs.count}/${cs.expectedCount}` : '0/0';
    $('missingGroups').textContent = `未評分組別：${cs?.missingGroups?.join('、') || '—'}`;
    renderOrderTable(); renderStatsTable();
  }

  function renderOrderTable() {
    const rows = [['順位', '上台報告', '負責提問', '檢查']];
    const total = Math.min(state.reportOrder.length, state.questionOrder.length);
    for (let i = 0; i < total; i++) rows.push([i + 1, state.reportOrder[i], state.questionOrder[i], state.reportOrder[i] === state.questionOrder[i] ? '衝突' : 'OK']);
    $('orderTable').innerHTML = rows.map((r, i) => `<tr class="${i && r[3] !== 'OK' ? 'conflict' : ''}">${r.map((c) => i ? `<td>${c}</td>` : `<th>${c}</th>`).join('')}</tr>`).join('');
  }

  function renderStatsTable() {
    const total = Math.min(state.reportOrder.length, state.questionOrder.length);
    const rows = [['順位', '報告組', '提問組', '報告平均', '提問平均', '評分進度', '未評分']];
    for (let i = 0; i < total; i++) {
      const s = roundStats(i);
      rows.push([s.roundNo, s.reportGroup, s.questionGroup, s.reportAvg ?? '—', s.questionAvg ?? '—', `${s.count}/${s.expectedCount}`, s.missingGroups.join('、') || '—']);
    }
    $('statsTable').innerHTML = rows.map((r, i) => `<tr>${r.map((c) => i ? `<td>${c}</td>` : `<th>${c}</th>`).join('')}</tr>`).join('');
  }

  function exportRows() {
    const total = Math.min(state.reportOrder.length, state.questionOrder.length);
    const summary = [[state.title], ['匯出時間', new Date().toLocaleString()], [], ['順位', '報告組別', '提問組別', '報告平均分', '提問平均分', '已評分組數', '應評分組數', '未評分組別']];
    for (let i = 0; i < total; i++) { const s = roundStats(i); summary.push([s.roundNo, s.reportGroup, s.questionGroup, s.reportAvg, s.questionAvg, s.count, s.expectedCount, s.missingGroups.join('、')]); }
    const groupSummary = [['組別', '報告順位', '報告平均', '提問順位', '提問平均']];
    for (const g of state.groups) {
      const ri = state.reportOrder.indexOf(g); const qi = state.questionOrder.indexOf(g);
      groupSummary.push([g, ri >= 0 ? ri + 1 : '', ri >= 0 ? roundStats(ri).reportAvg : '', qi >= 0 ? qi + 1 : '', qi >= 0 ? roundStats(qi).questionAvg : '']);
    }
    const raw = [['順位', '報告組別', '提問組別', '評分組別', '報告分數', '提問分數', '送出時間', '備註']];
    for (let i = 0; i < total; i++) for (const [scorer, v] of Object.entries(state.scores[i] || {})) raw.push([i + 1, state.reportOrder[i], state.questionOrder[i], scorer, v.reportScore, v.questionScore, v.submittedAt, v.comment || '']);
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
      try { state = { ...defaultState(), ...JSON.parse(reader.result) }; saveState(); renderTeacher(); broadcastState(); alert('已匯入備份。'); }
      catch (e) { alert('匯入失敗：' + e.message); }
    };
    reader.readAsText(file, 'utf-8');
  }

  function setupStudent() {
    $('studentApp').classList.remove('hidden');
    $('studentReportScore').oninput = () => $('studentReportScoreText').textContent = $('studentReportScore').value;
    $('studentQuestionScore').oninput = () => $('studentQuestionScoreText').textContent = $('studentQuestionScore').value;
    $('studentGroupSelect').onchange = renderStudentEligibility;
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
    const old = $('studentGroupSelect').value;
    $('studentGroupSelect').innerHTML = '<option value="">請選擇你的組別</option>' + (studentState.groups || []).map((g) => `<option value="${g}">${g}</option>`).join('');
    if (old) $('studentGroupSelect').value = old;
    renderStudentEligibility();
  }

  function renderStudentEligibility() {
    const g = $('studentGroupSelect').value;
    const cr = studentState?.currentRound || {};
    const msg = $('eligibilityMsg');
    const btn = $('submitScoreBtn');
    if (!g) { msg.className = 'notice mini'; msg.textContent = '請先選擇你的組別。'; btn.disabled = true; return; }
    if (g === cr.reportGroup) { msg.className = 'notice mini bad'; msg.textContent = '你們本輪是上台報告組，不需要評分。'; btn.disabled = true; return; }
    if (g === cr.questionGroup) { msg.className = 'notice mini bad'; msg.textContent = '你們本輪是負責提問組，不需要評分。'; btn.disabled = true; return; }
    msg.className = 'notice mini ok'; msg.textContent = '你們本輪是聽講評分組，請評分報告組與提問組。'; btn.disabled = false;
  }

  function submitStudentScore() {
    if (!studentConn?.open) return alert('尚未連線到老師端，請重新整理或重新掃 QR。');
    const scorerGroup = $('studentGroupSelect').value;
    if (!scorerGroup) return alert('請選擇你的組別。');
    const cr = studentState.currentRound;
    studentConn.send({ type: 'score', payload: { roundIndex: cr.index, scorerGroup, reportScore: Number($('studentReportScore').value), questionScore: Number($('studentQuestionScore').value), comment: $('studentComment').value } });
    $('submitMsg').textContent = '送出中…'; $('submitMsg').style.color = 'var(--muted)';
  }

  window.addEventListener('DOMContentLoaded', () => {
    if (isStudentMode) setupStudent(); else setupTeacher();
  });
})();
