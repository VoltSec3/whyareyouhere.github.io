(function () {
  const ROOMS_PATH = 'triad_rooms';
  const CARD_DB = [
    { id: 1, name: 'Ifrit', level: 1, top: 6, bottom: 2, left: 3, right: 5 },
    { id: 2, name: 'Shiva', level: 1, top: 5, bottom: 3, left: 2, right: 6 },
    { id: 3, name: 'Ramuh', level: 1, top: 4, bottom: 4, left: 4, right: 4 },
    { id: 4, name: 'Siren', level: 1, top: 3, bottom: 5, left: 6, right: 2 },
    { id: 5, name: 'Diablos', level: 2, top: 7, bottom: 3, left: 4, right: 6 },
    { id: 6, name: 'Carbuncle', level: 2, top: 5, bottom: 5, left: 3, right: 7 },
    { id: 7, name: 'Leviathan', level: 2, top: 6, bottom: 4, left: 7, right: 3 },
    { id: 8, name: 'Pandemona', level: 2, top: 8, bottom: 2, left: 5, right: 5 },
    { id: 9, name: 'Cerberus', level: 3, top: 7, bottom: 5, left: 6, right: 6 },
    { id: 10, name: 'Alexander', level: 3, top: 8, bottom: 4, left: 7, right: 5 },
    { id: 11, name: 'Phoenix', level: 3, top: 6, bottom: 8, left: 4, right: 7 },
    { id: 12, name: 'Bahamut', level: 4, top: 9, bottom: 6, left: 8, right: 7 },
    { id: 13, name: 'Tonberry', level: 1, top: 2, bottom: 7, left: 3, right: 4 },
    { id: 14, name: 'Cactuar', level: 1, top: 1, bottom: 8, left: 1, right: 8 },
    { id: 15, name: 'Malboro', level: 2, top: 6, bottom: 3, left: 7, right: 4 },
    { id: 16, name: 'R. Dragon', level: 3, top: 7, bottom: 7, left: 5, right: 5 }
  ];

  function seededRandom(seed) {
    return function () {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }

  function shuffleWithSeed(arr, seed) {
    const rng = seededRandom(seed);
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function getDb() {
    if (typeof firebase === 'undefined' || !firebase.database) return null;
    return firebase.database();
  }

  function randomId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  const isHost = params.get('host') === '1';
  if (!roomId) {
    window.location.href = 'index.html';
    throw new Error('no room');
  }

  const myRole = isHost ? 'host' : 'guest';
  const playerLabel = isHost ? 'You' : 'Opponent';
  const opponentLabel = isHost ? 'Opponent' : 'You';
  let myId = sessionStorage.getItem('triad_myId') || randomId();
  sessionStorage.setItem('triad_myId', myId);

  const gameBoard = document.getElementById('gameBoard');
  const playerHandEl = document.getElementById('playerHand');
  const opponentHandEl = document.getElementById('opponentHand');
  const playerScoreEl = document.getElementById('playerScore');
  const opponentScoreEl = document.getElementById('opponentScore');
  const playerWinsEl = document.getElementById('playerWins');
  const opponentWinsEl = document.getElementById('opponentWins');
  const statusEl = document.getElementById('statusText');
  const countdownEl = document.getElementById('countdownOverlay');
  const countdownNum = document.getElementById('countdownNum');
  const roundEndEl = document.getElementById('roundEndOverlay');
  const roundEndText = document.getElementById('roundEndText');

  let roomRef;
  let gameRef;
  let currentGame = null;
  let currentRoom = null;
  let previousPhase = null;
  let draggedCardIndex = null;
  let hoverTimeout = null;
  const HOVER_DELAY = 500;

  function cardToOwner(card) {
    if (!card || !card.owner) return card;
    const o = card.owner;
    return { ...card, owner: o === 'host' ? (isHost ? 'player' : 'opponent') : (isHost ? 'opponent' : 'player') };
  }

  function createCardElement(card, isDraggable) {
    const c = cardToOwner(card);
    const div = document.createElement('div');
    div.className = `card ${c.owner}`;
    div.draggable = isDraggable;
    div.innerHTML = `
      <div class="card-stats">
        <div class="stat top">${c.top}</div>
        <div class="stat left">${c.left}</div>
        <div class="stat right">${c.right}</div>
        <div class="stat bottom">${c.bottom}</div>
      </div>
      <div class="card-name">${c.name}</div>
    `;
    return div;
  }

  function renderBoard(board) {
    if (!board || board.length !== 9) return;
    const slots = gameBoard.querySelectorAll('.board-slot');
    slots.forEach((slot, i) => {
      slot.innerHTML = '';
      const card = board[i];
      if (card) slot.appendChild(createCardElement(card, false));
    });
  }

  function renderHands(hostHand, guestHand) {
    const myHand = isHost ? hostHand : guestHand;
    const oppHand = isHost ? guestHand : hostHand;
    playerHandEl.innerHTML = '';
    opponentHandEl.innerHTML = '';
    (myHand || []).forEach((card, index) => {
      const el = createCardElement(card, true);
      el.classList.add('hand-card');
      el.dataset.index = index;
      el.addEventListener('dragstart', (e) => handleDragStart(e, index));
      el.addEventListener('dragend', handleDragEnd);
      el.addEventListener('mouseenter', (e) => handleCardHover(e, true));
      el.addEventListener('mouseleave', handleCardLeave);
      playerHandEl.appendChild(el);
    });
    (oppHand || []).forEach((card) => {
      const el = createCardElement(card, false);
      el.classList.add('hand-card');
      opponentHandEl.appendChild(el);
    });
  }

  function getPlayerName() {
    const m = document.cookie.match(/\bname=([^;]*)/);
    return (m ? decodeURIComponent(m[1].trim()) : '') || 'Player';
  }

  function renderScores(hostScore, guestScore, hostWins, guestWins, hostName, guestName) {
    const ps = isHost ? hostScore : guestScore;
    const os = isHost ? guestScore : hostScore;
    const pw = isHost ? hostWins : guestWins;
    const ow = isHost ? guestWins : hostWins;
    const myName = isHost ? (hostName || 'You') : (guestName || 'You');
    const oppName = isHost ? (guestName || 'Opponent') : (hostName || 'Opponent');
    if (playerScoreEl) playerScoreEl.textContent = ps != null ? ps : 0;
    if (opponentScoreEl) opponentScoreEl.textContent = os != null ? os : 0;
    if (playerWinsEl) {
      playerWinsEl.textContent = pw != null ? pw : 0;
      const label = playerWinsEl.closest('.win-counter')?.querySelector('.player-wins-label');
      if (label) label.textContent = myName;
    }
    if (opponentWinsEl) {
      opponentWinsEl.textContent = ow != null ? ow : 0;
      const label = opponentWinsEl.closest('.win-counter')?.querySelector('.opponent-wins-label');
      if (label) label.textContent = oppName;
    }
  }

  function updateWinCounterNames(hostName, guestName) {
    const myName = isHost ? (hostName || getPlayerName()) : (guestName || getPlayerName());
    const oppName = isHost ? (guestName || 'Opponent') : (hostName || 'Opponent');
    const pl = document.querySelector('.player-wins-label');
    const ol = document.querySelector('.opponent-wins-label');
    if (pl) pl.textContent = myName;
    if (ol) ol.textContent = oppName;
  }

  function setGrayed(grayed) {
    playerHandEl.classList.toggle('deck-grayed', grayed);
    opponentHandEl.classList.toggle('deck-grayed', grayed);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function showCountdown(seconds) {
    if (!countdownEl || !countdownNum) return;
    countdownEl.classList.add('visible');
    let n = seconds;
    countdownNum.textContent = n;
    const t = setInterval(() => {
      n--;
      countdownNum.textContent = n;
      if (n <= 0) {
        clearInterval(t);
        countdownEl.classList.remove('visible');
      }
    }, 1000);
  }

  function showRoundEnd(winner) {
    if (!roundEndEl || !roundEndText) return;
    let msg = winner === 'draw' ? "It's a draw!" : (winner === myRole ? 'You win!' : 'You lose!');
    roundEndText.textContent = msg;
    roundEndEl.classList.add('visible');
    setTimeout(() => roundEndEl.classList.remove('visible'), 2000);
  }

  function handleDragStart(e, index) {
    if (!currentGame || currentGame.phase !== 'playing' || currentGame.currentTurn !== myRole) {
      e.preventDefault();
      return;
    }
    draggedCardIndex = index;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    gameBoard.querySelectorAll('.board-slot').forEach(s => s.classList.remove('drag-over'));
  }

  function handleCardHover(e, add) {
    const card = e.target.closest('.hand-card');
    if (!card) return;
    clearTimeout(hoverTimeout);
    document.querySelectorAll('.hand-card.expanded').forEach(el => { if (el !== card) el.classList.remove('expanded'); });
    if (add) card.classList.add('expanded'); else card.classList.remove('expanded');
  }

  function handleCardLeave() {
    hoverTimeout = setTimeout(() => {
      document.querySelectorAll('.hand-card.expanded').forEach(el => el.classList.remove('expanded'));
    }, HOVER_DELAY);
  }

  function getAdjacentPositions(position) {
    const row = Math.floor(position / 3), col = position % 3;
    const adj = [];
    if (row > 0) adj.push(position - 3);
    if (row < 2) adj.push(position + 3);
    if (col > 0) adj.push(position - 1);
    if (col < 2) adj.push(position + 1);
    return adj;
  }

  function shouldFlip(card, adjacentCard, position, adjacentPosition) {
    const row = Math.floor(position / 3), col = position % 3;
    const adjRow = Math.floor(adjacentPosition / 3), adjCol = adjacentPosition % 3;
    if (row === adjRow - 1) return card.bottom > adjacentCard.top;
    if (row === adjRow + 1) return card.top > adjacentCard.bottom;
    if (col === adjCol - 1) return card.right > adjacentCard.left;
    if (col === adjCol + 1) return card.left > adjacentCard.right;
    return false;
  }

  function applyFlips(board, position) {
    const boardCopy = board.map(c => c ? { ...c } : null);
    const card = boardCopy[position];
    if (!card) return boardCopy;
    getAdjacentPositions(position).forEach(adjPos => {
      const adj = boardCopy[adjPos];
      if (adj && adj.owner !== card.owner && shouldFlip(card, adj, position, adjPos)) {
        boardCopy[adjPos] = { ...adj, owner: card.owner };
      }
    });
    return boardCopy;
  }

  function playCard(position, cardIndex) {
    const db = getDb();
    if (!db || !currentGame) return;
    const g = currentGame;
    if (g.phase !== 'playing' || g.currentTurn !== myRole) return;
    const myHand = isHost ? g.hostHand : g.guestHand;
    if (!myHand || cardIndex < 0 || cardIndex >= myHand.length) return;
    if (g.board[position] !== null) return;

    const card = { ...myHand[cardIndex], owner: myRole, position };
    const newBoard = g.board.slice();
    newBoard[position] = card;
    const afterFlips = applyFlips(newBoard, position);
    const newMyHand = myHand.filter((_, i) => i !== cardIndex);
    const hostHand = isHost ? newMyHand : g.hostHand;
    const guestHand = isHost ? g.guestHand : newMyHand;

    const filled = afterFlips.filter(Boolean).length;
    let hostWins = g.hostWins || 0, guestWins = g.guestWins || 0;
    let phase = g.phase, currentTurn = g.currentTurn, roundEndAt = null, roundWinner = null;
    let hostScore = g.hostScore, guestScore = g.guestScore;

    if (filled === 9) {
      const hostCards = afterFlips.filter(c => c && c.owner === 'host').length;
      const guestCards = afterFlips.filter(c => c && c.owner === 'guest').length;
      hostScore = hostCards;
      guestScore = guestCards;
      if (hostCards > guestCards) hostWins++;
      else if (guestCards > hostCards) guestWins++;
      roundWinner = hostCards > guestCards ? 'host' : (guestCards > hostCards ? 'guest' : 'draw');
      phase = 'round_end';
      roundEndAt = Date.now() + 2000;
      currentTurn = null;
    } else {
      currentTurn = myRole === 'host' ? 'guest' : 'host';
    }

    gameRef.update({
      board: afterFlips,
      hostHand,
      guestHand,
      currentTurn,
      hostScore: hostScore != null ? hostScore : g.hostScore,
      guestScore: guestScore != null ? guestScore : g.guestScore,
      hostWins,
      guestWins,
      phase,
      roundWinner: roundWinner != null ? roundWinner : g.roundWinner,
      roundEndAt
    });
  }

  function handleDrop(e) {
    e.preventDefault();
    const slot = e.target.closest('.board-slot');
    if (!slot || draggedCardIndex == null) return;
    const position = parseInt(slot.dataset.position, 10);
    slot.classList.remove('drag-over');
    playCard(position, draggedCardIndex);
    draggedCardIndex = null;
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const slot = e.target.closest('.board-slot');
    if (slot && currentGame && currentGame.board[slot.dataset.position] === null) slot.classList.add('drag-over');
  }

  function handleDragLeave(e) {
    const slot = e.target.closest('.board-slot');
    if (slot) slot.classList.remove('drag-over');
  }

  function createBoardSlots() {
    gameBoard.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'board-slot';
      slot.dataset.position = i;
      slot.addEventListener('dragover', handleDragOver);
      slot.addEventListener('drop', handleDrop);
      slot.addEventListener('dragleave', handleDragLeave);
      gameBoard.appendChild(slot);
    }
  }

  function startCountdownIfNeeded(g) {
    if (!g || g.phase !== 'countdown' || !g.countdownEndAt) return;
    const now = Date.now();
    if (g.countdownEndAt <= now) return;
    const secLeft = Math.ceil((g.countdownEndAt - now) / 1000);
    if (secLeft <= 5) showCountdown(secLeft);
  }

  function runDealIfNeeded(g) {
    if (!g || g.phase !== 'countdown' || !g.countdownEndAt) return;
    if (Date.now() < g.countdownEndAt) return;
    const db = getDb();
    if (!db) return;
    const seed = g.dealSeed || Date.now();
    const shuffled = shuffleWithSeed(CARD_DB.map(c => ({ ...c })), seed);
    const hostHand = shuffled.slice(0, 5).map(c => ({ ...c, owner: 'host' }));
    const guestHand = shuffled.slice(5, 10).map(c => ({ ...c, owner: 'guest' }));
    gameRef.transaction((data) => {
      if (!data || data.phase !== 'countdown') return;
      return {
        ...data,
        phase: 'playing',
        hostHand,
        guestHand,
        board: Array(9).fill(null),
        currentTurn: 'host',
        hostScore: 0,
        guestScore: 0,
        roundWinner: null,
        roundEndAt: null
      };
    });
  }

  function runNextRoundIfNeeded(g) {
    if (g.phase !== 'round_end' || !g.roundEndAt) return;
    if (Date.now() < g.roundEndAt) return;
    const seed = (g.dealSeed || Date.now()) + 1;
    const shuffled = shuffleWithSeed(CARD_DB.map(c => ({ ...c })), seed);
    const hostHand = shuffled.slice(0, 5).map(c => ({ ...c, owner: 'host' }));
    const guestHand = shuffled.slice(5, 10).map(c => ({ ...c, owner: 'guest' }));
    const nextState = {
      phase: 'playing',
      hostHand,
      guestHand,
      board: Array(9).fill(null),
      currentTurn: 'host',
      hostScore: 0,
      guestScore: 0,
      roundWinner: null,
      roundEndAt: null,
      dealSeed: seed
    };
    gameRef.transaction((data) => {
      if (!data || data.phase !== 'round_end' || !data.roundEndAt || Date.now() < data.roundEndAt) return undefined;
      return { ...data, ...nextState };
    });
  }

  function onRoomSnapshot(snap) {
    const room = snap.val();
    currentRoom = room;
    if (!room) {
      setStatus('Room was deleted.');
      return;
    }
    updateWinCounterNames(room.hostName, room.guestName);
    const g = room.game || {};
    const hasGuest = !!(room.guestId);
    if (g.phase !== 'countdown' && g.phase !== 'playing' && g.phase !== 'round_end') {
      setGrayed(true);
      if (isHost) setStatus(hasGuest ? 'Opponent joined. Starting soon...' : 'Waiting for opponent...');
      else setStatus('Waiting for game to start...');
      if (hasGuest && (!g.phase || g.phase === 'waiting')) {
        const db = getDb();
        if (db) {
          gameRef.transaction(function (data) {
            if (!data || data.phase !== 'waiting') return undefined;
            return {
              ...data,
              phase: 'countdown',
              countdownEndAt: Date.now() + 5000,
              dealSeed: Date.now()
            };
          });
        }
      }
    }
  }

  function onGameSnapshot(snap) {
    const g = snap.val();
    currentGame = g;
    if (!g) return;
    const prev = previousPhase;
    previousPhase = g.phase;
    const room = currentRoom;

    if (g.phase === 'countdown') {
      setGrayed(true);
      setStatus('Get ready!');
      updateWinCounterNames(room && room.hostName, room && room.guestName);
      startCountdownIfNeeded(g);
      runDealIfNeeded(g);
    } else if (g.phase === 'playing') {
      setGrayed(false);
      const turn = g.currentTurn;
      if (turn === myRole) setStatus('Your turn');
      else setStatus('Opponent\'s turn');
      renderBoard(g.board);
      renderHands(g.hostHand, g.guestHand);
      renderScores(g.hostScore, g.guestScore, g.hostWins, g.guestWins, room && room.hostName, room && room.guestName);
    } else if (g.phase === 'round_end') {
      setGrayed(false);
      renderBoard(g.board);
      renderHands(g.hostHand, g.guestHand);
      renderScores(g.hostScore, g.guestScore, g.hostWins, g.guestWins, room && room.hostName, room && room.guestName);
      if (prev !== 'round_end') showRoundEnd(g.roundWinner);
      runNextRoundIfNeeded(g);
    }
  }

  function setupPresence() {
    const db = getDb();
    if (!db) return;
    const ref = roomRef;
    const onlineKey = isHost ? 'hostOnline' : 'guestOnline';
    ref.child(onlineKey).set(true);
    ref.child(onlineKey).onDisconnect().set(false);
    ref.child('lastActivityAt').set(Date.now());
  }

  function init() {
    createBoardSlots();
    const db = getDb();
    if (!db) {
      setStatus('Firebase not available.');
      return;
    }
    roomRef = db.ref(ROOMS_PATH + '/' + roomId);
    gameRef = roomRef.child('game');

    roomRef.on('value', onRoomSnapshot);
    gameRef.on('value', onGameSnapshot);

    if (isHost) {
      roomRef.child('guestId').on('value', (guestSnap) => {
        if (!guestSnap.val()) return;
        roomRef.once('value', (roomSnap) => {
          onRoomSnapshot(roomSnap);
          var room = roomSnap.val();
          var g = (room && room.game) || {};
          if (g.phase === 'waiting' || !g.phase) {
            gameRef.transaction(function (data) {
              if (!data || data.phase !== 'waiting') return undefined;
              return {
                ...data,
                phase: 'countdown',
                countdownEndAt: Date.now() + 5000,
                dealSeed: Date.now()
              };
            });
          }
        });
      });

      roomRef.once('value', (snap) => {
        const room = snap.val();
        if (!room) {
          setStatus('Room not found.');
          return;
        }
        if (room.hostId && room.hostId !== myId) {
          setStatus('Someone else is host.');
          return;
        }
        const myName = getPlayerName();
        roomRef.update({
          hostId: room.hostId || myId,
          hostName: myName,
          hostOnline: true,
          lastActivityAt: Date.now(),
          emptySince: null
        });
        gameRef.transaction(function (data) {
          if (data) return undefined;
          return {
            phase: 'waiting',
            hostWins: 0,
            guestWins: 0,
            hostScore: 0,
            guestScore: 0,
            board: Array(9).fill(null),
            hostHand: [],
            guestHand: [],
            currentTurn: null,
            roundWinner: null,
            roundEndAt: null,
            countdownEndAt: null,
            dealSeed: null
          };
        });
        setupPresence();
      });
    } else {
      const myName = getPlayerName();
      roomRef.transaction((room) => {
        if (!room) return undefined;
        if (room.guestId) return undefined;
        return {
          ...room,
          guestId: myId,
          guestName: myName,
          guestOnline: true,
          lastActivityAt: Date.now(),
          emptySince: null,
          game: room.game || {
            phase: 'waiting',
            hostWins: 0,
            guestWins: 0,
            hostScore: 0,
            guestScore: 0,
            board: Array(9).fill(null),
            hostHand: [],
            guestHand: [],
            currentTurn: null,
            roundWinner: null,
            roundEndAt: null,
            countdownEndAt: null,
            dealSeed: null
          }
        };
      }, (err, committed, snap) => {
        if (err || !committed) {
          setStatus(snap && snap.val() && snap.val().guestId ? 'Room is full (2 players already).' : 'Could not join (room full or gone).');
          return;
        }
        setupPresence();
        gameRef.transaction(function (data) {
          if (!data || data.phase !== 'waiting') return undefined;
          return {
            ...data,
            phase: 'countdown',
            countdownEndAt: Date.now() + 5000,
            dealSeed: Date.now()
          };
        });
      });
    }
  }

  window.addEventListener('beforeunload', () => {
    if (roomRef && typeof roomRef.child('').onDisconnect !== 'undefined') {
      const key = isHost ? 'hostOnline' : 'guestOnline';
      roomRef.child(key).set(false);
    }
  });

  init();
})();
