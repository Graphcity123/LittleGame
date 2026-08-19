const roleParam = new URLSearchParams(location.search).get('role');
const VALID_ROLES = [
  'red_captain',
  'blue_captain',
  'red_member',
  'blue_member',
  'observer'
];
const role = VALID_ROLES.includes(roleParam) ? roleParam : null;
const team = role && role.startsWith('red_') ? 'red' : role && role.startsWith('blue_') ? 'blue' : null;
const roleType = role === 'observer' ? 'observer' : role ? role.split('_')[1] : null;
const isCaptain = roleType === 'captain';
const isMember = roleType === 'member';
const isObserver = role === 'observer';

const ROLE_LABELS = {
  red_captain: '红方队长',
  blue_captain: '蓝方队长',
  red_member: '红方队员',
  blue_member: '蓝方队员',
  observer: '观察者'
};

const ROLE_STATUS = [
  { role: 'red_captain', label: '红方队长' },
  { role: 'blue_captain', label: '蓝方队长' },
  { role: 'red_member', label: '红方队员', multi: true },
  { role: 'blue_member', label: '蓝方队员', multi: true },
  { role: 'observer', label: '观察者', multi: true }
];

const el = {
  landing: document.getElementById('landing'),
  lobby: document.getElementById('lobby'),
  game: document.getElementById('game'),
  blocked: document.getElementById('blocked'),
  blockedTitle: document.getElementById('blockedTitle'),
  blockedDetail: document.getElementById('blockedDetail'),
  originUrl: document.getElementById('originUrl'),
  roleBadge: document.getElementById('roleBadge'),
  newGameBtn: document.getElementById('newGameBtn'),
  lobbyTitle: document.getElementById('lobbyTitle'),
  lobbyDetail: document.getElementById('lobbyDetail'),
  lobbyStartBtn: document.getElementById('lobbyStartBtn'),
  lobbyConfig: document.getElementById('lobbyConfig'),
  roleStatusGrid: document.getElementById('roleStatusGrid'),
  connectionBanner: document.getElementById('connectionBanner'),
  redScore: document.getElementById('redScore'),
  blueScore: document.getElementById('blueScore'),
  turnBanner: document.getElementById('turnBanner'),
  phaseHint: document.getElementById('phaseHint'),
  controlTitle: document.getElementById('controlTitle'),
  captainPanel: document.getElementById('captainPanel'),
  memberPanel: document.getElementById('memberPanel'),
  memberTitle: document.getElementById('memberTitle'),
  observerPanel: document.getElementById('observerPanel'),
  observerClue: document.getElementById('observerClue'),
  observerFlips: document.getElementById('observerFlips'),
  gameConfigPanel: document.getElementById('gameConfigPanel'),
  gameConfig: document.getElementById('gameConfig'),
  clueWord: document.getElementById('clueWord'),
  clueCount: document.getElementById('clueCount'),
  clueSubmit: document.getElementById('clueSubmit'),
  flipProgress: document.getElementById('flipProgress'),
  flipLimit: document.getElementById('flipLimit'),
  passBtn: document.getElementById('passBtn'),
  board: document.getElementById('board'),
  boardFoot: document.getElementById('boardFoot'),
  redClueLog: document.getElementById('redClueLog'),
  blueClueLog: document.getElementById('blueClueLog'),
  eventLog: document.getElementById('eventLog'),
  toast: document.getElementById('toast'),
  winnerOverlay: document.getElementById('winnerOverlay'),
  winnerTitle: document.getElementById('winnerTitle'),
  winnerDetail: document.getElementById('winnerDetail'),
  closeWinnerBtn: document.getElementById('closeWinnerBtn'),
  cluePopup: document.getElementById('cluePopup'),
  cluePopupTag: document.getElementById('cluePopupTag'),
  cluePopupWord: document.getElementById('cluePopupWord'),
  cluePopupCount: document.getElementById('cluePopupCount'),
  cluePopupLimit: document.getElementById('cluePopupLimit'),
  cluePopupClose: document.getElementById('cluePopupClose')
};

let state = null;
let ws = null;
let blocked = false;
let toastTimer = null;
let cluePopupTimer = null;
let winnerOverlayTimer = null;

function teamName(teamValue) {
  return teamValue === 'red' ? '红队' : '蓝队';
}

function opponentName(teamValue) {
  return teamValue === 'red' ? '蓝队' : '红队';
}

function showToast(message, type = 'info') {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.className = `toast ${type}`;
  requestAnimationFrame(() => {
    el.toast.classList.add('visible');
  });
  toastTimer = window.setTimeout(() => {
    el.toast.classList.remove('visible');
  }, 2600);
}

function setConnection(message, type = '') {
  el.connectionBanner.textContent = message;
  el.connectionBanner.className = `connection-banner ${type}`;
}

function connect() {
  if (blocked) {
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${protocol}${location.host}/ws?role=${role}`);

  ws.addEventListener('open', () => {
    setConnection('正在同步房间状态', 'info');
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (message.type === 'state') {
      const previous = state;
      state = message;
      if (
        message.game &&
        message.game.phase === 'guess' &&
        (
          isObserver ||
          (isMember && role === `${message.game.currentTeam}_member`)
        ) &&
        previous &&
        previous.game &&
        previous.game.phase === 'clue' &&
        message.game.clueWord
      ) {
        showCluePopup(message.game);
      }
      render();
      return;
    }

    if (message.type === 'occupied') {
      blocked = true;
      el.game.classList.add('hidden');
      el.lobby.classList.add('hidden');
      el.blockedTitle.textContent = '角色已被占用';
      el.blockedDetail.textContent = message.message || '请关闭另一端后重试。';
      el.blocked.classList.remove('hidden');
      if (ws) {
        ws.close();
      }
      return;
    }

    if (message.type === 'error') {
      showToast(message.message || '操作失败', 'warn');
    }
  });

  ws.addEventListener('close', () => {
    if (blocked) {
      return;
    }
    ws = null;
    setConnection('连接断开，正在重连', 'warn');
    window.setTimeout(connect, 1200);
  });
}

function sendAction(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !state) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

const CONFIG_FIELDS = [
  { key: 'rows', label: '行', options: configRange(4, 8) },
  { key: 'cols', label: '列', options: configRange(4, 8) },
  { key: 'red', label: '红队词', options: configRange(1, 25) },
  { key: 'blue', label: '蓝队词', options: configRange(1, 25) },
  { key: 'bomb', label: '炸弹词', options: configRange(0, 10) }
];

function configRange(start, end) {
  const values = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}

function buildConfigPanel(container, onChange) {
  const controls = document.createElement('div');
  controls.className = 'config-controls';
  CONFIG_FIELDS.forEach((field) => {
    const label = document.createElement('label');
    label.className = 'config-field';
    const name = document.createElement('span');
    name.className = 'config-label';
    name.textContent = field.label;
    const select = document.createElement('select');
    select.dataset.config = field.key;
    field.options.forEach((value) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = field.format ? field.format(value) : String(value);
      select.appendChild(option);
    });
    select.addEventListener('change', onChange);
    label.appendChild(name);
    label.appendChild(select);
    controls.appendChild(label);
  });
  container.appendChild(controls);
}

function syncConfig() {
  if (!state || !state.config) {
    return;
  }
  [el.lobbyConfig, el.gameConfig].forEach((container) => {
    container.querySelectorAll('select[data-config]').forEach((select) => {
      const value = state.config[select.dataset.config];
      if (value != null) {
        select.value = String(value);
      }
    });
  });
}

function handleConfigChange(container) {
  return () => {
    if (!state || !state.config) {
      return;
    }
    const read = (key) => parseInt(container.querySelector(`select[data-config="${key}"]`).value, 10);
    const rows = read('rows');
    const cols = read('cols');
    const red = read('red');
    const blue = read('blue');
    const bomb = read('bomb');
    const total = rows * cols;
    if (red < 1 || blue < 1 || bomb < 0 || red + blue + bomb > total) {
      showToast(`配置无效：红队 + 蓝队 + 炸弹（${red + blue + bomb}）不能超过卡片总数（${total}）`, 'warn');
      syncConfig();
      return;
    }
    sendAction({ action: 'set_config', rows, cols, red, blue, bomb });
  };
}

function render() {
  if (!state) {
    return;
  }

  const game = state.game;
  const allConnected = state.allRequiredConnected;
  const connected = state.connected;

  el.roleBadge.textContent = ROLE_LABELS[role];
  el.roleBadge.className = `role-badge ${role}`;
  el.newGameBtn.classList.toggle('hidden', !isObserver);
  el.newGameBtn.disabled = !state.canStart;
  syncConfig();

  if (!game) {
    el.landing.classList.add('hidden');
    el.game.classList.add('hidden');
    el.lobby.classList.remove('hidden');
    el.lobbyConfig.classList.toggle('hidden', !isObserver);
    el.gameConfigPanel.classList.add('hidden');
    renderLobby(allConnected, connected, state.counts || {});
    return;
  }

  el.lobby.classList.add('hidden');
  el.game.classList.remove('hidden');
  document.body.classList.toggle('role-captain', isCaptain);
  document.body.classList.toggle('role-member', isMember);
  document.body.classList.toggle('role-observer', isObserver);

  el.captainPanel.classList.toggle('hidden', !isCaptain);
  el.memberPanel.classList.toggle('hidden', !isMember);
  el.observerPanel.classList.toggle('hidden', !isObserver);
  el.lobbyConfig.classList.add('hidden');
  el.gameConfigPanel.classList.toggle('hidden', !(isObserver && game.winner));

  if (!connected.red_captain || !connected.blue_captain || !connected.red_member || !connected.blue_member || !connected.observer) {
    setConnection('部分角色已离线，游戏可继续', 'warn');
  } else {
    setConnection('所有角色已连接', 'success');
  }

  renderScores();
  renderTurn();
  renderControls();
  renderBoard();
  renderHistory();
  renderWinner();
}

function renderLobby(allConnected, connected, counts) {
  el.roleStatusGrid.innerHTML = '';
  ROLE_STATUS.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'role-status-row';
    const name = document.createElement('span');
    name.className = 'role-status-name';
    const count = counts[item.role] || 0;
    name.textContent = item.multi && count > 1 ? `${item.label} ×${count}` : item.label;
    const dot = document.createElement('span');
    dot.className = 'role-status-dot';
    dot.classList.toggle('connected', Boolean(connected[item.role]));
    dot.setAttribute('data-role', item.role);
    row.appendChild(name);
    row.appendChild(dot);
    el.roleStatusGrid.appendChild(row);
  });

  el.lobbyTitle.textContent = allConnected ? '角色已就绪' : '等待角色连接';
  el.lobbyDetail.textContent = allConnected
    ? '所有角色已连接，等待观察者开启新局。'
    : '需要红方队长、蓝方队长、至少各一位红方队员、蓝方队员和观察者。';
  el.lobbyStartBtn.classList.toggle('hidden', !isObserver);
  el.lobbyStartBtn.disabled = !state.canStart;
  el.lobbyStartBtn.textContent = allConnected ? '观察者开启新局' : '等待角色全部连接';
}

function renderScores() {
  const game = state.game;
  const config = state.config;
  el.redScore.textContent = `${game.score.red}/${config.red}`;
  el.blueScore.textContent = `${game.score.blue}/${config.blue}`;
}

function renderTurn() {
  const game = state.game;
  const current = teamName(game.currentTeam);

  if (game.winner) {
    el.turnBanner.textContent = '对局结束';
    el.phaseHint.textContent = `${teamName(game.winner)}胜利`;
    el.controlTitle.textContent = '对局结束';
    el.memberTitle.textContent = '对局结束';
    el.observerClue.textContent = '对局结束';
    return;
  }

  if (game.phase === 'clue') {
    el.turnBanner.textContent = `${current}回合`;
    el.phaseHint.textContent = `等待${current}队长提示`;
    el.controlTitle.textContent = `${current}队长提示`;
    el.memberTitle.textContent = `${current}队员等待提示`;
    el.observerClue.textContent = '等待提示';
  } else {
    el.turnBanner.textContent = `${current}队员翻词`;
    el.phaseHint.textContent = `提示「${game.clueWord}」 · 最多 ${game.limit} 词`;
    el.controlTitle.textContent = `${current}队员翻词`;
    el.memberTitle.textContent = `${current}队员翻词`;
    el.observerClue.textContent = game.clueWord;
  }
  el.observerFlips.textContent = String(game.flips);
}

function renderControls() {
  const can = state.canAct;
  el.clueWord.disabled = !can.submitClue;
  el.clueCount.disabled = !can.submitClue;
  el.clueSubmit.disabled = !can.submitClue;
  el.passBtn.disabled = !can.pass;
  el.flipProgress.textContent = String(state.game.flips);
  el.flipLimit.textContent = String(state.game.limit);
}

function renderBoard() {
  el.board.innerHTML = '';
  const game = state.game;
  const config = state.config;
  const reveal = isCaptain || Boolean(game.winner);

  const total = config.rows * config.cols;
  const neutral = total - config.red - config.blue - config.bomb;
  el.board.style.gridTemplateColumns = `repeat(${config.cols}, minmax(0, 1fr))`;
  el.boardFoot.textContent = `红方 ${config.red} 目标 · 蓝方 ${config.blue} 目标 · 炸弹 ${config.bomb} · 无效 ${neutral}`;

  game.board.forEach((card, index) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'word-cell';
    cell.dataset.index = String(index);
    if (card.color) {
      cell.dataset.color = card.color;
    }
    cell.disabled = !state.canAct.flip || card.flipped;

    if (card.flipped) {
      cell.classList.add('is-' + card.color, 'flipped');
    }
    if (reveal) {
      cell.classList.add('captain-view');
    }

    const word = document.createElement('span');
    word.className = 'word-text';
    word.textContent = card.word;
    cell.appendChild(word);

    const kind = document.createElement('span');
    kind.className = 'card-kind';
    kind.textContent = card.kind || '';
    if (!card.kind) {
      kind.hidden = true;
    }
    cell.appendChild(kind);

    if (reveal && !card.flipped) {
      const marker = document.createElement('span');
      marker.className = 'color-marker';
      marker.setAttribute('aria-hidden', 'true');
      cell.appendChild(marker);
    }

    cell.setAttribute('aria-label', card.flipped ? `${card.word}，已翻开` : card.word);
    cell.addEventListener('click', () => {
      sendAction({ action: 'flip', index });
    });
    el.board.appendChild(cell);
  });
}

function renderHistory() {
  el.redClueLog.innerHTML = '';
  el.blueClueLog.innerHTML = '';
  el.eventLog.innerHTML = '';

  const history = state.game.history;
  const redClues = history.filter((item) => item.team === 'red').slice(-10).reverse();
  const blueClues = history.filter((item) => item.team === 'blue').slice(-10).reverse();

  redClues.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.text.replace(/^红队：/, '');
    el.redClueLog.appendChild(li);
  });

  blueClues.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.text.replace(/^蓝队：/, '');
    el.blueClueLog.appendChild(li);
  });

  history.slice(-30).reverse().forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.text;
    if (item.tone) {
      li.classList.add(item.tone);
    }
    el.eventLog.appendChild(li);
  });
}

function renderWinner() {
  const game = state.game;
  if (!game.winner) {
    window.clearTimeout(winnerOverlayTimer);
    winnerOverlayTimer = null;
    el.winnerOverlay.classList.add('hidden');
    return;
  }

  el.winnerTitle.textContent = `${teamName(game.winner)}胜利`;
  el.winnerDetail.textContent = game.winReason === 'bomb'
    ? `${opponentName(game.winner)}翻到了炸弹词`
    : '目标词已全部翻开';
  el.closeWinnerBtn.classList.add('hidden');
  el.winnerOverlay.classList.remove('hidden');
  if (!winnerOverlayTimer) {
    winnerOverlayTimer = window.setTimeout(() => {
      winnerOverlayTimer = null;
      el.winnerOverlay.classList.add('hidden');
    }, 3000);
  }
}

function showCluePopup(game) {
  hideCluePopup();
  const currentTeam = game.currentTeam;
  el.cluePopup.classList.remove('hidden', 'red', 'blue');
  el.cluePopup.classList.add(currentTeam);
  el.cluePopupTag.textContent = `${teamName(currentTeam)}提示词`;
  el.cluePopupWord.textContent = game.clueWord;
  el.cluePopupCount.textContent = `暗示 ${game.clueCount} 词`;
  el.cluePopupLimit.textContent = `最多翻 ${game.limit} 词`;
  el.cluePopupClose.textContent = `${teamName(currentTeam)}开始翻词`;
  el.cluePopupClose.classList.add('hidden');
  cluePopupTimer = window.setTimeout(() => {
    hideCluePopup();
  }, 3000);
}

function hideCluePopup() {
  window.clearTimeout(cluePopupTimer);
  cluePopupTimer = null;
  el.cluePopup.classList.add('hidden');
}

function submitClue() {
  if (!state || !state.canAct || !state.canAct.submitClue) {
    return;
  }
  sendAction({
    action: 'submit_clue',
    clueWord: el.clueWord.value,
    clueCount: el.clueCount.value
  });
  el.clueWord.value = '';
}

function init() {
  if (!role) {
    el.originUrl.textContent = `${location.origin}/`;
    return;
  }

  el.landing.classList.add('hidden');
  el.roleBadge.textContent = ROLE_LABELS[role];
  connect();
}

el.newGameBtn.addEventListener('click', () => {
  sendAction({ action: 'new_game' });
});
el.lobbyStartBtn.addEventListener('click', () => {
  sendAction({ action: 'new_game' });
});
el.clueSubmit.addEventListener('click', submitClue);
el.clueWord.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    submitClue();
  }
});
el.passBtn.addEventListener('click', () => {
  sendAction({ action: 'pass' });
});
el.closeWinnerBtn.addEventListener('click', () => {
  el.winnerOverlay.classList.add('hidden');
});
el.cluePopupClose.addEventListener('click', () => {
  hideCluePopup();
});

buildConfigPanel(el.lobbyConfig, handleConfigChange(el.lobbyConfig));
buildConfigPanel(el.gameConfig, handleConfigChange(el.gameConfig));

init();
