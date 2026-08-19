// 阿瓦隆 · 六人局域网联机版 客户端
const ROLE_META = {
  merlin: { label: '梅林', faction: 'good', icon: '🧙', desc: '知道谁是好人谁是坏人，但会把莫德雷德认成好人' },
  percival: { label: '派西维尔', faction: 'good', icon: '🛡️', desc: '知道梅林和莫甘娜，但分不清谁是谁' },
  loyal: { label: '忠臣', faction: 'good', icon: '⚔️', desc: '普通平民，无特殊能力' },
  morgana: { label: '莫甘娜', faction: 'evil', icon: '🌹', desc: '与除奥伯伦以外的红方队友互认' },
  assassin: { label: '刺客', faction: 'evil', icon: '🗡️', desc: '与除奥伯伦以外的红方队友互认，可随时行刺' },
  minion: { label: '爪牙', faction: 'evil', icon: '🐺', desc: '与除奥伯伦以外的红方队友互认' },
  oberon: { label: '奥伯伦', faction: 'evil', icon: '👑', desc: '不会被红方队友看见，但会被梅林看见' },
  mordred: { label: '莫德雷德', faction: 'evil', icon: '🐍', desc: '与红方队友互认，但梅林会把你认成好人' },
  lancelot: { label: '兰斯洛特', faction: 'good', icon: '🐎', desc: '第三轮可能随机叛变为坏人；破坏任务会留下讯息' }
};
const FACTION_LABELS = { good: '好人阵营', evil: '坏人阵营' };
const PHASE_STAGE = {
  role_reveal: '身份确认',
  info_reveal: '信息确认',
  propose: '选人',
  speech: '发言',
  vote: '发车投票',
  mission: '任务投票',
  lady: '湖中仙女',
  assassinate: '刺杀',
  ended: '结束'
};

const el = {
  landing: document.getElementById('landing'),
  lobby: document.getElementById('lobby'),
  game: document.getElementById('game'),
  nickname: document.getElementById('nickname'),
  joinBtn: document.getElementById('joinBtn'),
  lobbyTitle: document.getElementById('lobbyTitle'),
  lobbyDetail: document.getElementById('lobbyDetail'),
  lobbyPlayers: document.getElementById('lobbyPlayers'),
  lobbyStartBtn: document.getElementById('lobbyStartBtn'),
  lobbyCount: document.getElementById('lobbyCount'),
  lobbyDeepWater: document.getElementById('lobbyDeepWater'),
  nicknameBadge: document.getElementById('nicknameBadge'),
  phaseLabel: document.getElementById('phaseLabel'),
  connectionBanner: document.getElementById('connectionBanner'),
  roundLabel: document.getElementById('roundLabel'),
  roundTrack: document.getElementById('roundTrack'),
  seatMapLabel: document.getElementById('seatMapLabel'),
  seatMap: document.getElementById('seatMap'),
  myIdentity: document.getElementById('myIdentity'),
  phasePanel: document.getElementById('phasePanel'),
  history: document.getElementById('history'),
  toast: document.getElementById('toast'),
  winnerOverlay: document.getElementById('winnerOverlay'),
  winnerTitle: document.getElementById('winnerTitle'),
  winnerDetail: document.getElementById('winnerDetail'),
  roleReveal: document.getElementById('roleReveal'),
  resetBtn: document.getElementById('resetBtn'),
  confirmOverlay: document.getElementById('confirmOverlay'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmDetail: document.getElementById('confirmDetail'),
  confirmCancelBtn: document.getElementById('confirmCancelBtn'),
  confirmOkBtn: document.getElementById('confirmOkBtn'),
  resultOverlay: document.getElementById('resultOverlay'),
  resultCard: document.getElementById('resultCard'),
  resultKind: document.getElementById('resultKind'),
  resultStatus: document.getElementById('resultStatus'),
  resultCounts: document.getElementById('resultCounts'),
  roundDetailOverlay: document.getElementById('roundDetailOverlay'),
  roundDetailTitle: document.getElementById('roundDetailTitle'),
  roundDetailBody: document.getElementById('roundDetailBody'),
  roundDetailCloseBtn: document.getElementById('roundDetailCloseBtn'),
  reviewBtn: document.getElementById('reviewBtn'),
  reviewBackBtn: document.getElementById('reviewBackBtn')
};

let state = null;
let ws = null;
let toastTimer = null;
let selectedSeats = [];
let lastPhase = null;
let lastSpeakerSeat = null;
let pendingNickname = null;
let confirmCallback = null;
let resultBaseline = 0;
let privateBaseline = 0;
let resultTimer = null;
let reviewMode = false;
let noticeQueue = [];
let noticeShowing = false;

// 稳定玩家 id：刷新/重连时保持同一身份
let playerId = sessionStorage.getItem('avalon_player_id');
if (!playerId) {
  playerId = 'p-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  sessionStorage.setItem('avalon_player_id', playerId);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showToast(message, type = 'info') {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.className = `toast ${type}`;
  requestAnimationFrame(() => el.toast.classList.add('visible'));
  toastTimer = window.setTimeout(() => el.toast.classList.remove('visible'), 2600);
}

function setConnection(message, type = '') {
  el.connectionBanner.textContent = message;
  el.connectionBanner.className = `connection-banner ${type}`;
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${protocol}${location.host}/ws?id=${encodeURIComponent(playerId)}`);

  ws.addEventListener('open', () => {
    setConnection('正在同步房间状态', 'info');
    // 刷新 / 重连：若之前保存过昵称，自动重新加入
    const name = pendingNickname || sessionStorage.getItem('avalon_nickname');
    if (name) {
      pendingNickname = null;
      sendAction({ action: 'join', nickname: name });
    }
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (message.type === 'state') {
      state = message;
      render();
      return;
    }

    if (message.type === 'error') {
      showToast(message.message || '操作失败', 'warn');
    }
  });

  ws.addEventListener('error', () => {
    setConnection('连接出错，正在重试', 'warn');
  });

  ws.addEventListener('close', () => {
    ws = null;
    setConnection('连接断开，正在重连', 'warn');
    window.setTimeout(connect, 1200);
  });
}

function sendAction(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function join() {
  const nickname = el.nickname.value.trim();
  if (!nickname) {
    showToast('请输入昵称', 'warn');
    return;
  }
  sessionStorage.setItem('avalon_nickname', nickname);
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendAction({ action: 'join', nickname });
  } else {
    // 连接尚未建立：记下昵称，连接建立后自动加入
    pendingNickname = nickname;
    showToast('正在连接服务器…');
  }
}

// ---------- 渲染 ----------

function render() {
  if (!state) {
    showPanel('landing');
    return;
  }

  el.nicknameBadge.textContent = state.nickname || '';
  el.nicknameBadge.classList.toggle('hidden', !state.nickname);
  el.phaseLabel.classList.toggle('hidden', !state.game);
  document.body.classList.toggle('deep', !!state.deepWater);

  if (state.game) {
    showPanel('game');
    renderGame(state.game);
  } else {
    reviewMode = false;
    resultBaseline = 0;
    privateBaseline = 0;
    noticeQueue = [];
    noticeShowing = false;
    window.clearTimeout(resultTimer);
    el.resultOverlay.classList.add('hidden');
    el.reviewBackBtn.classList.add('hidden');
    if (state.nickname) {
      showPanel('lobby');
      renderLobby();
    } else {
      showPanel('landing');
    }
  }
}

function showPanel(name) {
  el.landing.classList.toggle('hidden', name !== 'landing');
  el.lobby.classList.toggle('hidden', name !== 'lobby');
  el.game.classList.toggle('hidden', name !== 'game');
}

function renderLobby() {
  el.lobbyPlayers.innerHTML = '';
  if (el.lobbyCount) el.lobbyCount.value = String(state.maxPlayers);
  if (el.lobbyDeepWater) {
    el.lobbyDeepWater.checked = !!state.deepWater;
  }
  const joined = state.joinedNicknames || [];
  for (let i = 0; i < state.maxPlayers; i++) {
    const name = joined[i];
    const div = document.createElement('div');
    div.className = name ? 'lobby-player' : 'lobby-player empty';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = name || `空位 ${i + 1}`;
    div.appendChild(dot);
    div.appendChild(text);
    el.lobbyPlayers.appendChild(div);
  }

  const full = joined.length >= state.maxPlayers;
  el.lobbyTitle.textContent = full ? '玩家已就绪' : '等待玩家加入';
  el.lobbyDetail.textContent = full
    ? `${state.maxPlayers} 名玩家已加入，任意一人点击开始。`
    : `已加入 ${joined.length} / ${state.maxPlayers} 人。`;
  el.lobbyStartBtn.classList.toggle('hidden', !state.canStart);
  el.lobbyStartBtn.disabled = !state.canStart;
  el.lobbyStartBtn.textContent = full ? '开始游戏' : '等待玩家加入';
}

function renderGame(game) {
  if (game.phase !== lastPhase) {
    selectedSeats = [];
    lastPhase = game.phase;
  }

  // 发言环节：轮到自己的座位时醒目提醒（仅在新轮到自己时触发一次）
  if (game.phase === 'speech' && game.mySeat
    && game.speakerSeat === game.mySeat
    && game.speakerSeat !== lastSpeakerSeat) {
    displayResult({ kind: 'speech' });
  }
  lastSpeakerSeat = game.phase === 'speech' ? game.speakerSeat : null;

  const online = game.seats.filter((s) => s.online).length;
  if (game.phase === 'ended') {
    setConnection('对局结束', '');
  } else if (online < game.seats.length) {
    setConnection(`${online} / ${game.seats.length} 名玩家在线`, 'warn');
  } else {
    setConnection('所有玩家已连接', 'success');
  }

  renderPhaseLabel(game);
  maybeShowResult(game);
  maybeShowPrivateResults(game);
  renderRoundTrack(game);
  renderSeatMap(game);
  renderIdentity(game);
  renderPhasePanel(game);
  renderHistory(game);
  renderWinner(game);
}

function seatCode(seat, game) {
  const s = (game.seats || []).find((x) => x.seat === seat);
  return s && s.nickname ? `${seat}·${s.nickname}` : `${seat}·?`;
}

function tipLabel(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

function renderPhaseLabel(game) {
  const stage = PHASE_STAGE[game.phase] || game.phase;
  if (game.phase === 'role_reveal' || game.phase === 'info_reveal') {
    el.phaseLabel.textContent = `准备阶段 · ${stage}`;
  } else if (game.phase === 'ended') {
    el.phaseLabel.textContent = '对局结束';
  } else {
    el.phaseLabel.textContent = `第 ${game.round} 轮 · ${stage}`;
  }
}

function renderRoundTrack(game) {
  const sizes = game.teamSizes || [2, 3, 4, 3, 4];
  const missionsByRound = {};
  (game.missions || []).forEach((m) => { missionsByRound[m.round] = m; });

  const currentRound = ['propose', 'speech', 'vote', 'mission'].includes(game.phase)
    ? game.round
    : 0;

  el.roundLabel.textContent = `任务轮次 · 好人 ${game.score.good} : 坏人 ${game.score.evil}`;

  el.roundTrack.innerHTML = '';
  sizes.forEach((size, idx) => {
    const round = idx + 1;
    const mission = missionsByRound[round];
    const box = document.createElement('div');
    let cls = 'round-box';
    if (mission) cls += mission.success ? ' round-success' : ' round-fail';
    else if (round === currentRound) cls += ' round-current';
    else cls += ' round-pending';
    box.className = cls;

    const num = document.createElement('span');
    num.className = 'round-size';
    num.textContent = size;
    const label = document.createElement('span');
    label.className = 'round-label';
    label.textContent = `第${round}轮`;
    box.appendChild(num);
    box.appendChild(label);

    if (mission) {
      box.appendChild(buildRoundTip(mission, game));
      box.classList.add('clickable');
      box.addEventListener('click', () => openRoundDetail(round));
    }

    el.roundTrack.appendChild(box);
  });
}

function buildRoundTip(mission, game) {
  const tip = document.createElement('div');
  tip.className = 'round-tip ' + (mission.success ? 'tip-success' : 'tip-fail');

  const title = document.createElement('div');
  title.className = 'tip-title';
  title.textContent = `第${mission.round}轮：${mission.success ? '成功' : '失败'}`;
  tip.appendChild(title);

  const leader = document.createElement('div');
  leader.className = 'tip-line';
  leader.appendChild(tipLabel('车长：'));
  leader.appendChild(document.createTextNode(
    mission.leaderSeat ? seatCode(mission.leaderSeat, game) : '—'
  ));
  tip.appendChild(leader);

  const votersHead = document.createElement('div');
  votersHead.className = 'tip-line';
  votersHead.appendChild(tipLabel('投票人：'));
  tip.appendChild(votersHead);

  (mission.seats || []).forEach((s) => {
    const v = document.createElement('div');
    v.className = 'tip-voter';
    v.textContent = seatCode(s, game);
    tip.appendChild(v);
  });

  return tip;
}

function detailRow(label, value, tone, sub) {
  const row = document.createElement('div');
  row.className = 'round-detail-row' + (sub ? ' round-detail-sub' : '');
  const l = document.createElement('span');
  l.className = 'round-detail-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'round-detail-value' + (tone ? ` ${tone}` : '');
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function seatList(seats, game) {
  return (seats || []).map((s) => seatCode(s, game)).join('、');
}

function openRoundDetail(round) {
  const game = state.game;
  const mission = (game.missions || []).find((m) => m.round === round);
  if (!mission) return;

  const ended = game.phase === 'ended';
  const boardings = (game.boardings || []).filter((b) => b.round === round);

  el.roundDetailTitle.textContent = `第${round}轮 · 任务${mission.success ? '成功' : '失败'}`;
  el.roundDetailTitle.className = mission.success ? 'good' : 'evil';

  const body = el.roundDetailBody;
  body.innerHTML = '';

  body.appendChild(detailRow(
    '车长',
    mission.leaderSeat ? seatCode(mission.leaderSeat, game) : '—'
  ));

  if (boardings.length) {
    boardings.forEach((b, i) => {
      const label = boardings.length > 1 ? `发车投票 · 第${i + 1}次` : '发车投票';
      body.appendChild(detailRow(
        label,
        `赞成 ${b.approve} · 反对 ${b.reject}（${b.passed ? '成功' : '失败'}）`,
        b.passed ? 'good' : 'bad'
      ));
      if (ended) {
        if (b.approveSeats && b.approveSeats.length) {
          body.appendChild(detailRow('投赞成', seatList(b.approveSeats, game), 'good', true));
        }
        if (b.rejectSeats && b.rejectSeats.length) {
          body.appendChild(detailRow('投反对', seatList(b.rejectSeats, game), 'bad', true));
        }
      }
    });
  } else {
    body.appendChild(detailRow('发车投票', '强制上车（取消投票）'));
  }

  if (ended) {
    if (mission.successSeats && mission.successSeats.length) {
      body.appendChild(detailRow('投成功', seatList(mission.successSeats, game), 'good', true));
    }
    if (mission.failSeats && mission.failSeats.length) {
      body.appendChild(detailRow('投失败', seatList(mission.failSeats, game), 'bad', true));
    }
  }

  body.appendChild(detailRow(
    '上车成员',
    (mission.seats || []).map((s) => seatCode(s, game)).join('、')
  ));

  el.roundDetailOverlay.classList.remove('hidden');
}

function closeRoundDetail() {
  el.roundDetailOverlay.classList.add('hidden');
}

function renderResultNotice(result) {
  let tone;
  if (result.kind === 'boarding') {
    tone = result.ok ? 'good' : 'bad';
    el.resultKind.textContent = '发车结果';
    el.resultStatus.textContent = result.ok ? '发车成功' : '发车失败';
    el.resultCounts.textContent = `赞成 ${result.a} 人 · 反对 ${result.b} 人`;
  } else if (result.kind === 'mission') {
    tone = result.ok ? 'good' : 'bad';
    el.resultKind.textContent = '任务结果';
    el.resultStatus.textContent = result.ok ? '任务成功' : '任务失败';
    el.resultCounts.textContent = '';
  } else if (result.kind === 'speech') {
    tone = 'speech';
    el.resultKind.textContent = '发言提醒';
    el.resultStatus.textContent = '轮到你发言';
    el.resultCounts.textContent = '请表达对本次发车的看法';
  } else if (result.kind === 'lady') {
    tone = result.faction === 'good' ? 'good' : 'bad';
    el.resultKind.textContent = '湖中仙女查验';
    el.resultStatus.textContent = `${result.target}号·${result.targetNickname}`;
    el.resultCounts.textContent = result.faction === 'good' ? '是好人阵营' : '是坏人阵营';
  } else if (result.kind === 'lancelot') {
    tone = result.flipped ? 'bad' : 'good';
    el.resultKind.textContent = '兰斯洛特阵营';
    el.resultStatus.textContent = result.flipped ? '你已叛变为坏人' : '你仍是好人';
    el.resultCounts.textContent = '仅你可见';
  } else if (result.kind === 'lancelot_merlin') {
    tone = result.flipped ? 'bad' : 'good';
    el.resultKind.textContent = '兰斯洛特阵营';
    el.resultStatus.textContent = result.flipped
      ? `${result.lancelotSeat}号·${result.nickname} 叛变为坏人`
      : `${result.lancelotSeat}号·${result.nickname} 仍是好人`;
    el.resultCounts.textContent = '仅你（梅林）可见';
  } else if (result.kind === 'lancelot_trace') {
    tone = 'bad';
    el.resultKind.textContent = '破坏讯息';
    el.resultStatus.textContent = `${result.nickname} 参与破坏`;
    el.resultCounts.textContent = '兰斯洛特留下了参与破坏的讯息';
  } else {
    tone = 'assassinate';
    el.resultKind.textContent = '行刺环节';
    el.resultStatus.textContent = '刺客行刺';
    el.resultCounts.textContent = '请刺客选择刺杀目标';
  }
  el.resultCard.className = 'result-card ' + tone;
  el.resultOverlay.classList.remove('hidden');
}

function displayResult(result) {
  noticeShowing = true;
  renderResultNotice(result);
  window.clearTimeout(resultTimer);
  resultTimer = window.setTimeout(pumpResultNotice, 2200);
}

function pumpResultNotice() {
  if (!noticeQueue.length) {
    noticeShowing = false;
    el.resultOverlay.classList.add('hidden');
    return;
  }
  displayResult(noticeQueue.shift());
}

function enqueueResultNotice(result) {
  noticeQueue.push(result);
  if (!noticeShowing) pumpResultNotice();
}

function showAssassinateImmediate(result) {
  noticeQueue = [];
  displayResult(result);
}

function maybeShowResult(game) {
  const results = game.lastResults || [];
  const fresh = results.filter((r) => r.seq > resultBaseline);
  if (fresh.length) {
    resultBaseline = Math.max(...fresh.map((r) => r.seq));
    fresh.forEach((r) => {
      if (r.kind === 'assassinate' && r.mode === 'voluntary') {
        showAssassinateImmediate(r);
      } else {
        enqueueResultNotice(r);
      }
    });
  }
}

function maybeShowPrivateResults(game) {
  const results = game.privateResults || [];
  const fresh = results.filter((r) => r.seq > privateBaseline);
  if (fresh.length) {
    privateBaseline = Math.max(...fresh.map((r) => r.seq));
    fresh.forEach((r) => enqueueResultNotice(r));
  }
}

function roleMarkForSeat(roleInfo, seat) {
  if (!roleInfo) return null;
  if (roleInfo.kind === 'merlin') {
    const isEvil = (roleInfo.evilSeats || []).includes(seat);
    return { cls: isEvil ? 'evil' : 'good', label: isEvil ? '坏人' : '好人' };
  }
  if (roleInfo.kind === 'percival') {
    if ((roleInfo.mysterySeats || []).includes(seat)) {
      return { cls: 'mystery', label: '梅林/莫甘娜' };
    }
    return null;
  }
  if (roleInfo.kind === 'evil') {
    const t = (roleInfo.teammates || []).find((x) => x.seat === seat);
    if (t) {
      const label = (ROLE_META[t.role] || {}).label || t.role;
      return { cls: 'evil', label };
    }
    return null;
  }
  return null;
}

function renderSeatMap(game) {
  el.seatMap.innerHTML = '';
  const count = (game.seats || []).length;
  const cols = count <= 6 ? count : Math.ceil(count / 2);
  el.seatMap.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  const selectable = state.canAct.propose || state.canAct.assassinate || state.canAct.ladyCheck;

  if (state.canAct.propose) {
    el.seatMapLabel.textContent = `编号对应人物 · 你是车长，点击选择 ${game.teamSize} 人上车`;
  } else if (state.canAct.assassinate) {
    el.seatMapLabel.textContent = '编号对应人物 · 点击选择刺杀目标';
  } else if (state.canAct.ladyCheck) {
    el.seatMapLabel.textContent = '编号对应人物 · 你是湖中仙女，点击查验一人';
  } else {
    el.seatMapLabel.textContent = '编号对应人物';
  }

  game.seats.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'seat';
    if (selectable) div.classList.add('selectable');
    if (s.seat === game.leaderSeat) div.classList.add('leader');
    if (game.ladySeat != null && s.seat === game.ladySeat) div.classList.add('lady');
    if (game.phase === 'speech' && s.seat === game.speakerSeat) div.classList.add('speaking');
    if (!reviewMode && game.proposal && game.proposal.includes(s.seat)) div.classList.add('on-mission');
    if (selectedSeats.includes(s.seat)) div.classList.add('selected');
    if (s.seat === game.mySeat) div.classList.add('me');
    if (!s.online) div.classList.add('offline');
    const know = !reviewMode ? roleMarkForSeat(game.roleInfo, s.seat) : null;
    if (know) div.classList.add('know-' + know.cls);

    const num = document.createElement('span');
    num.className = 'seat-num';
    num.textContent = `${s.seat} 号`;
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = s.nickname || '（空位）';
    const tag = document.createElement('span');
    tag.className = 'seat-tag';
    tag.textContent = s.seat === game.mySeat ? '（我）' : '';

    if (s.seat === game.leaderSeat) {
      const mark = document.createElement('span');
      mark.className = 'leader-mark';
      mark.textContent = '车长';
      div.appendChild(mark);
    }
    if (game.phase === 'speech' && s.seat === game.speakerSeat) {
      const mark = document.createElement('span');
      mark.className = 'speaker-mark';
      mark.textContent = '发言中';
      div.appendChild(mark);
    }
    if (game.ladySeat != null && s.seat === game.ladySeat) {
      const mark = document.createElement('span');
      mark.className = 'lady-mark';
      mark.textContent = '仙女';
      div.appendChild(mark);
    }
    if (selectedSeats.includes(s.seat)) {
      const mark = document.createElement('span');
      mark.className = 'selected-mark';
      mark.textContent = '✓';
      div.appendChild(mark);
    }

    div.appendChild(num);
    div.appendChild(name);
    if (know) {
      const kt = document.createElement('span');
      kt.className = 'know-tag';
      kt.textContent = know.label;
      div.appendChild(kt);
    }
    if (reviewMode && game.roleReveal && game.roleReveal[s.seat]) {
      const rv = game.roleReveal[s.seat];
      div.classList.add('reveal-' + rv.faction);
      const role = document.createElement('span');
      role.className = 'seat-role';
      role.textContent = rv.roleLabel;
      div.appendChild(role);
    }
    div.appendChild(tag);
    div.addEventListener('click', () => onSeatClick(s.seat));
    el.seatMap.appendChild(div);
  });
}

function onSeatClick(seat) {
  if (!state || !state.game) return;
  const game = state.game;

  if (state.canAct.propose) {
    const idx = selectedSeats.indexOf(seat);
    if (idx >= 0) {
      selectedSeats.splice(idx, 1);
    } else if (selectedSeats.length < game.teamSize) {
      selectedSeats.push(seat);
    } else {
      showToast(`最多选择 ${game.teamSize} 人`, 'warn');
    }
    renderSeatMap(game);
    renderPhasePanel(game);
  } else if (state.canAct.assassinate) {
    selectedSeats = [seat];
    renderSeatMap(game);
    renderPhasePanel(game);
  } else if (state.canAct.ladyCheck) {
    selectedSeats = [seat];
    renderSeatMap(game);
    renderPhasePanel(game);
  }
}

function seatPillHtml(seat, game, cls, label) {
  const s = (game.seats || []).find((x) => x.seat === seat);
  const name = s && s.nickname ? s.nickname : '';
  return `<span class="seat-pill ${cls}">${seat} 号${name ? ' · ' + esc(name) : ''}${label ? ' · ' + esc(label) : ''}</span>`;
}

function roleInfoHtml(roleInfo, game) {
  if (!roleInfo) return '';

  if (roleInfo.kind === 'merlin') {
    const evil = roleInfo.evilSeats || [];
    const pills = (game.seats || []).map((s) => {
      const cls = evil.includes(s.seat) ? 'evil' : 'good';
      return seatPillHtml(s.seat, game, cls);
    }).join('');
    return `
      <div class="knowledge-line">你能看到每个人的阵营：</div>
      <div class="seat-legend">${pills}</div>
      <div class="knowledge-note">红 = 坏人，蓝 = 好人；你分不清坏人的具体身份。</div>
    `;
  }

  if (roleInfo.kind === 'percival') {
    const pills = (roleInfo.mysterySeats || []).map((s) => seatPillHtml(s, game, 'mystery')).join('');
    return `
      <div class="knowledge-line">梅林和莫甘娜是下面这两位：</div>
      <div class="seat-legend">${pills}</div>
      <div class="knowledge-note">你分不清谁是谁。</div>
    `;
  }

  if (roleInfo.kind === 'evil') {
    const pills = (roleInfo.teammates || []).map((t) => {
      const label = (ROLE_META[t.role] || {}).label || t.role;
      return seatPillHtml(t.seat, game, 'evil', label);
    }).join('');
    return `
      <div class="knowledge-line">你的红方队友是：</div>
      <div class="seat-legend">${pills}</div>
    `;
  }

  return '';
}

function infoContent(roleInfo, game) {
  if (!roleInfo) {
    return '<div class="info-item">你没有额外阵营信息。</div>';
  }
  return `<div class="info-item">${roleInfoHtml(roleInfo, game)}</div>`;
}

function roleCardHtml(role) {
  const meta = ROLE_META[role] || { label: role, faction: 'good', icon: '?' };
  return `<div class="role-card-big ${meta.faction}">
    <div class="role-icon-big">${meta.icon}</div>
    <div>
      <div class="role-name">${meta.label}</div>
      <div class="role-faction">${FACTION_LABELS[meta.faction]}</div>
    </div>
  </div>`;
}

function votingStatusHtml(game) {
  const voters = game.phase === 'mission'
    ? (game.proposal || [])
    : (game.seats || []).map((s) => s.seat);
  const voted = game.votedSeats || [];
  const notVoted = voters.filter((s) => !voted.includes(s));
  if (!notVoted.length) {
    return '<div class="waiting-note">已全部投票，等待结算…</div>';
  }
  const names = notVoted.map((seat) => {
    const s = (game.seats || []).find((x) => x.seat === seat);
    return s && s.nickname ? `${seat}·${s.nickname}` : `${seat}·?`;
  }).join('、');
  return `<div class="waiting-note">已投票 ${voted.length}/${voters.length} · 未投票：${names}</div>`;
}

function renderPhasePanel(game) {
  const panel = el.phasePanel;
  const can = state.canAct;

  if (game.phase === 'role_reveal') {
    panel.innerHTML = `
      <h3 class="phase-title">身份确认</h3>
      <p class="phase-desc">你的身份是：</p>
      ${roleCardHtml(game.myRole)}
      ${can.confirm
        ? '<button id="confirmBtn" class="button button-primary button-block">确认收到身份</button>'
        : '<div class="waiting-note">已确认，等待其他玩家确认…</div>'}
    `;
    bindConfirm();
    return;
  }

  if (game.phase === 'info_reveal') {
    panel.innerHTML = `
      <h3 class="phase-title">信息确认</h3>
      <p class="phase-desc">你的阵营信息：</p>
      <div class="info-list">${infoContent(game.roleInfo, game)}</div>
      ${can.confirm
        ? '<button id="confirmBtn" class="button button-primary button-block">确认收到信息</button>'
        : '<div class="waiting-note">已确认，等待其他玩家确认…</div>'}
    `;
    bindConfirm();
    return;
  }

  if (game.phase === 'propose') {
    if (can.propose) {
      const attempt = game.rejections === 0
        ? '首次发车'
        : game.rejections === 1 ? '第 2 次发车' : '第 3 次发车 · 无需投票';
      const ready = selectedSeats.length === game.teamSize;
      panel.innerHTML = `
        <h3 class="phase-title">你是车长</h3>
        <p class="phase-desc">第 ${game.round} 轮 · 需选择 <strong>${game.teamSize}</strong> 人上车（${attempt}，点击上方座位选择）。</p>
        <div class="waiting-note">已选 ${selectedSeats.length} / ${game.teamSize} 人</div>
        <button id="proposeBtn" class="button button-primary button-block" ${ready ? '' : 'disabled'}>确认上车</button>
      `;
      document.getElementById('proposeBtn').addEventListener('click', () => {
        sendAction({ action: 'propose_team', seats: selectedSeats.slice() });
      });
    } else {
      panel.innerHTML = `
        <h3 class="phase-title">等待选人</h3>
        <div class="waiting-note">等待车长 <strong>${game.leaderNickname}</strong> 选择 ${game.teamSize} 人上车。</div>
      `;
    }
    return;
  }

  if (game.phase === 'speech') {
    const speaker = game.speakerSeat;
    const spokenNames = (game.spoken || []).map((s) => seatCode(s, game)).join('、');
    if (can.speechDone) {
      panel.innerHTML = `
        <h3 class="phase-title">轮到你发言</h3>
        <div class="speech-callout">🎤 现在轮到你发言，请表达对本次发车的看法</div>
        <button id="speechDoneBtn" class="button button-primary button-block">发言结束</button>
      `;
      document.getElementById('speechDoneBtn').addEventListener('click', () => {
        sendAction({ action: 'speech_done' });
      });
    } else {
      panel.innerHTML = `
        <h3 class="phase-title">发言环节</h3>
        <div class="waiting-note">当前发言人：<strong>${seatCode(speaker, game)}</strong>${spokenNames ? `<br>已发言：${spokenNames}` : ''}</div>
      `;
    }
    return;
  }

  if (game.phase === 'vote') {
    if (can.voteBoarding) {
      panel.innerHTML = `
        <h3 class="phase-title">发车投票</h3>
        <p class="phase-desc">是否赞成这辆车上路？（匿名投票，赞成 ≥ ${game.requiredApproves} 票发车成功）</p>
        <div class="vote-row">
          <button id="approveBtn" class="button vote-approve">赞成发车</button>
          <button id="rejectBtn" class="button vote-reject">不赞成</button>
        </div>
        ${votingStatusHtml(game)}
      `;
      document.getElementById('approveBtn').addEventListener('click', () => {
        sendAction({ action: 'vote_boarding', approve: true });
      });
      document.getElementById('rejectBtn').addEventListener('click', () => {
        sendAction({ action: 'vote_boarding', approve: false });
      });
    } else {
      panel.innerHTML = `
        <h3 class="phase-title">等待投票</h3>
        <div class="waiting-note">你已投票，等待其他玩家投票。</div>
        ${votingStatusHtml(game)}
      `;
    }
    return;
  }

  if (game.phase === 'mission') {
    const onMission = game.proposal && game.proposal.includes(game.mySeat);
    if (can.voteMission) {
      const isGood = game.myFaction === 'good';
      panel.innerHTML = `
        <h3 class="phase-title">执行任务</h3>
        <p class="phase-desc">匿名投票，${isGood ? '好人阵营必须投任务成功。' : '你可以选择任务成功或任务失败。'}</p>
        <div class="vote-row">
          <button id="successBtn" class="button vote-success">任务成功</button>
          ${isGood ? '' : '<button id="failBtn" class="button vote-fail">任务失败</button>'}
        </div>
        ${votingStatusHtml(game)}
      `;
      document.getElementById('successBtn').addEventListener('click', () => {
        sendAction({ action: 'vote_mission', success: true });
      });
      if (!isGood) {
        document.getElementById('failBtn').addEventListener('click', () => {
          sendAction({ action: 'vote_mission', success: false });
        });
      }
    } else {
      const note = onMission
        ? '你已投票，等待车上其他成员投票。'
        : '你不在车上，等待车上成员执行任务。';
      panel.innerHTML = `
        <h3 class="phase-title">任务进行中</h3>
        <div class="waiting-note">${note}</div>
        ${votingStatusHtml(game)}
      `;
    }
    return;
  }

  if (game.phase === 'lady') {
    if (can.ladyCheck) {
      const ready = selectedSeats.length === 1;
      panel.innerHTML = `
        <h3 class="phase-title">湖中仙女查验</h3>
        <p class="phase-desc">你是湖中仙女，点击上方座位查验一人的阵营。查验后仙女将转交给 TA。</p>
        <div class="waiting-note">${ready ? `将查验 ${selectedSeats[0]} 号` : '请选择要查验的人（不能选自己）'}</div>
        <button id="ladyCheckBtn" class="button button-primary button-block" ${ready ? '' : 'disabled'}>确认查验</button>
      `;
      document.getElementById('ladyCheckBtn').addEventListener('click', () => {
        sendAction({ action: 'lady_check', target: selectedSeats[0] });
      });
    } else {
      panel.innerHTML = `
        <h3 class="phase-title">湖中仙女查验</h3>
        <div class="waiting-note">等待湖中仙女（${seatCode(game.ladySeat, game)}）查验一人。</div>
      `;
    }
    return;
  }

  if (game.phase === 'assassinate') {
    if (can.assassinate) {
      const ready = selectedSeats.length === 1;
      panel.innerHTML = `
        <h3 class="phase-title">刺客行刺</h3>
        <p class="phase-desc">请选择要刺杀的对象（点击上方座位）。刺中梅林则坏人胜利，否则好人胜利。</p>
        <button id="assassinateBtn" class="button button-primary button-block" ${ready ? '' : 'disabled'}>确认刺杀</button>
      `;
      document.getElementById('assassinateBtn').addEventListener('click', () => {
        askConfirm(
          '确认刺杀该目标？',
          `将刺杀 ${selectedSeats[0]} 号，行刺后本局立即结束。`,
          '确认刺杀',
          () => sendAction({ action: 'assassinate', target: selectedSeats[0] })
        );
      });
    } else {
      panel.innerHTML = `
        <h3 class="phase-title">等待行刺</h3>
        <div class="waiting-note">等待刺客选择刺杀对象。</div>
      `;
    }
    return;
  }

  panel.innerHTML = `
    <h3 class="phase-title">对局结束</h3>
    <div class="waiting-note">${game.winner === 'good' ? '好人胜利' : '坏人胜利'}</div>
  `;
}

function bindConfirm() {
  const btn = document.getElementById('confirmBtn');
  if (btn) {
    btn.addEventListener('click', () => sendAction({ action: 'confirm' }));
  }
}

function renderIdentity(game) {
  if (!game.myRole) {
    el.myIdentity.innerHTML = '<div class="waiting-note">尚未分配身份。</div>';
    return;
  }
  const meta = ROLE_META[game.myRole] || { label: game.myRole, faction: 'good' };
  const myFaction = game.myFaction || meta.faction;
  const info = roleInfoHtml(game.roleInfo, game);
  const seat = game.mySeat ? `<span class="my-seat">${game.mySeat} 号</span>` : '';
  const assassinateBtn = state.canAct.startAssassinate
    ? '<button id="startAssassinateBtn" class="button vote-fail assassinate-now-btn">发起刺杀</button>'
    : '';
  el.myIdentity.innerHTML = `
    <div class="my-identity">
      ${seat}<span class="role-chip ${myFaction}"><span class="dot"></span>${meta.label}</span>
      <div class="identity-info">${FACTION_LABELS[myFaction]} · ${esc(meta.desc)}</div>
      ${info ? `<div class="identity-info">${info}</div>` : ''}
      ${assassinateBtn}
    </div>
  `;
  if (state.canAct.startAssassinate) {
    document.getElementById('startAssassinateBtn').addEventListener('click', () => {
      askConfirm(
        '确认现在发起行刺？',
        '行刺后本局立即结束：刺中梅林则坏人胜利，否则好人胜利。',
        '确认行刺',
        () => sendAction({ action: 'assassinate_now' })
      );
    });
  }
}

function renderHistory(game) {
  el.history.innerHTML = '';
  const items = game.history.slice(-40).reverse();
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.text;
    if (item.tone) li.classList.add(item.tone);
    el.history.appendChild(li);
  });
}

function renderWinner(game) {
  const isEnded = game.phase === 'ended' && !!game.winner;
  el.reviewBackBtn.classList.toggle('hidden', !(isEnded && reviewMode));

  if (!isEnded || reviewMode) {
    el.winnerOverlay.classList.add('hidden');
    return;
  }

  const goodWin = game.winner === 'good';
  el.winnerTitle.textContent = goodWin ? '好人阵营胜利' : '坏人阵营胜利';
  el.winnerTitle.className = goodWin ? 'good' : 'evil';
  el.winnerDetail.textContent = game.winReason || '';

  el.roleReveal.innerHTML = '';
  const seats = Object.keys(game.roleReveal).map(Number).sort((a, b) => a - b);
  seats.forEach((seat) => {
    const info = game.roleReveal[seat];
    const row = document.createElement('div');
    row.className = 'role-reveal-row';
    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = `${seat} 号 · ${info.nickname}`;
    const role = document.createElement('span');
    role.className = `rrole ${info.faction}`;
    role.textContent = `${info.roleLabel}（${FACTION_LABELS[info.faction]}）`;
    row.appendChild(name);
    row.appendChild(role);
    el.roleReveal.appendChild(row);
  });

  el.winnerOverlay.classList.remove('hidden');
}

// ---------- 二次确认 ----------

function askConfirm(title, detail, okText, onOk) {
  el.confirmTitle.textContent = title;
  el.confirmDetail.textContent = detail;
  el.confirmOkBtn.textContent = okText || '确认';
  confirmCallback = onOk;
  el.confirmOverlay.classList.remove('hidden');
}

function closeConfirm() {
  confirmCallback = null;
  el.confirmOverlay.classList.add('hidden');
}

// ---------- 事件绑定 ----------

el.joinBtn.addEventListener('click', join);
el.nickname.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') join();
});
el.lobbyStartBtn.addEventListener('click', () => {
  sendAction({ action: 'start' });
});
if (el.lobbyCount) {
  el.lobbyCount.addEventListener('change', () => {
    sendAction({ action: 'set_player_count', count: parseInt(el.lobbyCount.value, 10) });
  });
}
if (el.lobbyDeepWater) {
  el.lobbyDeepWater.addEventListener('change', () => {
    sendAction({ action: 'set_deep_water', deepWater: el.lobbyDeepWater.checked });
  });
}
el.resetBtn.addEventListener('click', () => {
  sendAction({ action: 'reset' });
  el.winnerOverlay.classList.add('hidden');
});
el.confirmCancelBtn.addEventListener('click', closeConfirm);
el.confirmOkBtn.addEventListener('click', () => {
  const cb = confirmCallback;
  closeConfirm();
  if (cb) cb();
});
el.reviewBtn.addEventListener('click', () => {
  reviewMode = true;
  el.winnerOverlay.classList.add('hidden');
  el.reviewBackBtn.classList.remove('hidden');
  if (state && state.game) renderSeatMap(state.game);
});
el.reviewBackBtn.addEventListener('click', () => {
  reviewMode = false;
  if (state && state.game) {
    renderSeatMap(state.game);
    renderWinner(state.game);
  }
});
el.roundDetailCloseBtn.addEventListener('click', closeRoundDetail);
el.roundDetailOverlay.addEventListener('click', (event) => {
  if (event.target === el.roundDetailOverlay) closeRoundDetail();
});
el.resultOverlay.addEventListener('click', () => {
  window.clearTimeout(resultTimer);
  noticeQueue = [];
  noticeShowing = false;
  el.resultOverlay.classList.add('hidden');
});

function init() {
  const savedNickname = sessionStorage.getItem('avalon_nickname');
  if (savedNickname) {
    el.nickname.value = savedNickname;
  }
  connect();
}

init();
