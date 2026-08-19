const roleParam = new URLSearchParams(location.search).get('role');
const role = roleParam === 'captain' ? 'captain' : roleParam === 'member' ? 'member' : null;

const el = {
  landing: document.getElementById('landing'),
  game: document.getElementById('game'),
  blocked: document.getElementById('blocked'),
  blockedTitle: document.getElementById('blockedTitle'),
  blockedDetail: document.getElementById('blockedDetail'),
  originUrl: document.getElementById('originUrl'),
  roleBadge: document.getElementById('roleBadge'),
  newGameBtn: document.getElementById('newGameBtn'),
  connectionBanner: document.getElementById('connectionBanner'),
  redScore: document.getElementById('redScore'),
  blueScore: document.getElementById('blueScore'),
  turnBanner: document.getElementById('turnBanner'),
  phaseHint: document.getElementById('phaseHint'),
  controlTitle: document.getElementById('controlTitle'),
  captainPanel: document.getElementById('captainPanel'),
  memberPanel: document.getElementById('memberPanel'),
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

function teamName(team) {
  return team === 'red' ? '红队' : '蓝队';
}

function opponentName(team) {
  return team === 'red' ? '蓝队' : '红队';
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
        role === 'member' &&
        previous &&
        previous.game.phase === 'clue' &&
        message.game.phase === 'guess' &&
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

function render() {
  if (!state || !state.game) {
    return;
  }

  const game = state.game;
  const connected = state.connected;
  const allConnected = connected.captain && connected.member;

  if (role === 'member' && game.phase !== 'guess') {
    hideCluePopup();
  }

  document.body.classList.toggle('role-captain', role === 'captain');
  document.body.classList.toggle('role-member', role === 'member');
  document.body.classList.toggle('waiting', !allConnected);
  el.roleBadge.textContent = role === 'captain' ? '队长端' : '队员端';
  el.roleBadge.className = `role-badge ${role}`;
  el.newGameBtn.classList.toggle('hidden', role !== 'captain');
  el.captainPanel.classList.toggle('hidden', role !== 'captain');
  el.memberPanel.classList.toggle('hidden', role !== 'member');

  if (!connected.captain) {
    setConnection('等待队长端连接', 'warn');
  } else if (!connected.member) {
    setConnection('等待队员端连接', 'warn');
  } else {
    setConnection('两台电脑已连接', 'success');
  }

  renderScores();
  renderTurn();
  renderControls();
  renderBoard();
  renderHistory();
  renderWinner();
}

function renderScores() {
  const game = state.game;
  el.redScore.textContent = `${game.score.red}/9`;
  el.blueScore.textContent = `${game.score.blue}/8`;
}

function renderTurn() {
  const game = state.game;
  const current = teamName(game.currentTeam);

  if (game.winner) {
    el.turnBanner.textContent = '对局结束';
    el.phaseHint.textContent = `${teamName(game.winner)}胜利`;
    el.controlTitle.textContent = '对局结束';
    return;
  }

  if (game.phase === 'clue') {
    el.turnBanner.textContent = `${current}回合`;
    el.phaseHint.textContent = '等待队长提示';
    el.controlTitle.textContent = `${current}队长提示`;
  } else {
    el.turnBanner.textContent = `${current}队员翻词`;
    el.phaseHint.textContent = `提示「${game.clueWord}」 · 最多 ${game.limit} 词`;
    el.controlTitle.textContent = `${current}队员翻词`;
  }
}

function renderControls() {
  const can = state.canAct;
  const game = state.game;
  el.clueWord.disabled = !can.submitClue;
  el.clueCount.disabled = !can.submitClue;
  el.clueSubmit.disabled = !can.submitClue;
  el.passBtn.disabled = !can.pass;
  el.flipProgress.textContent = String(game.flips);
  el.flipLimit.textContent = String(game.limit);
}

function renderBoard() {
  el.board.innerHTML = '';
  const game = state.game;
  const reveal = role === 'captain' || Boolean(game.winner);

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

  const redClues = state.game.history
    .filter((item) => item.team === 'red')
    .slice(-10)
    .reverse();
  const blueClues = state.game.history
    .filter((item) => item.team === 'blue')
    .slice(-10)
    .reverse();

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
}

function renderWinner() {
  const game = state.game;
  if (!game.winner) {
    el.winnerOverlay.classList.add('hidden');
    return;
  }

  el.winnerTitle.textContent = `${teamName(game.winner)}胜利`;
  el.winnerDetail.textContent = game.winReason === 'bomb'
    ? `${opponentName(game.winner)}翻到了炸弹词`
    : '目标词已全部翻开';
  el.winnerOverlay.classList.remove('hidden');
}

function showCluePopup(game) {
  hideCluePopup();
  const team = game.currentTeam;
  el.cluePopup.classList.remove('hidden', 'red', 'blue');
  el.cluePopup.classList.add(team);
  el.cluePopupTag.textContent = `${teamName(team)}提示词`;
  el.cluePopupWord.textContent = game.clueWord;
  el.cluePopupCount.textContent = `暗示 ${game.clueCount} 词`;
  el.cluePopupLimit.textContent = `最多翻 ${game.limit} 词`;
  el.cluePopupClose.textContent = `${teamName(team)}开始翻词`;
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
  if (!state || !state.canAct.submitClue) {
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
  el.game.classList.remove('hidden');
  el.roleBadge.textContent = role === 'captain' ? '队长端' : '队员端';
  connect();
}

el.newGameBtn.addEventListener('click', () => {
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

init();
