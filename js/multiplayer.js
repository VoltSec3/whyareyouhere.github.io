(function () {
  const ROOMS_PATH = 'triad_rooms';
  const EMPTY_GRACE_MS = 2 * 60 * 1000;
  const ADMIN_COOKIE_VALUE = 'he33loWorl3d';

  function randomId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[2]).trim() : '';
  }

  function setCookie(name, value) {
    document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;max-age=31536000';
  }

  function getOrPromptName() {
    var name = getCookie('name');
    if (name) return name;
    name = prompt('Enter your display name (required to join or create rooms):', '');
    if (name == null) return null;
    name = (name || '').trim();
    if (!name) {
      alert('Please enter a name.');
      return null;
    }
    setCookie('name', name);
    return name;
  }

  function isAdmin() {
    return getCookie('adminCookie') === ADMIN_COOKIE_VALUE;
  }

  const landing = document.getElementById('landing');
  const multiplayerLobby = document.getElementById('multiplayer-lobby');
  const btnMultiplayer = document.getElementById('btnMultiplayer');
  const btnBack = document.getElementById('btnBack');
  const roomSearch = document.getElementById('roomSearch');
  const roomDropdown = document.getElementById('roomDropdown');
  const btnCreateRoom = document.getElementById('btnCreateRoom');
  const roomsList = document.getElementById('roomsList');
  const createRoomModal = document.getElementById('createRoomModal');
  const roomNameInput = document.getElementById('roomName');
  const roomPasswordLock = document.getElementById('roomPasswordLock');
  const passwordField = document.getElementById('passwordField');
  const roomPasswordInput = document.getElementById('roomPassword');
  const btnModalCancel = document.getElementById('btnModalCancel');
  const btnModalCreate = document.getElementById('btnModalCreate');

  let allRooms = [];
  let roomsUnsubscribe = null;

  function showLanding() {
    landing.style.display = 'flex';
    multiplayerLobby.classList.remove('visible');
  }

  function showLobby() {
    landing.style.display = 'none';
    multiplayerLobby.classList.add('visible');
    roomSearch.value = '';
    attachRoomsListener();
  }

  function getDb() {
    if (typeof firebase === 'undefined' || !firebase.database) return null;
    return firebase.database();
  }

  function attachRoomsListener() {
    const db = getDb();
    if (!db) {
      renderRooms([]);
      return;
    }
    if (roomsUnsubscribe) roomsUnsubscribe();
    const ref = db.ref(ROOMS_PATH);
    roomsUnsubscribe = ref.on('value', (snap) => {
      const val = snap.val();
      allRooms = [];
      if (val && typeof val === 'object') {
        const now = Date.now();
        Object.keys(val).forEach((id) => {
          const room = { id, ...val[id] };
          const hostOff = room.hostOnline === false;
          const guestOff = room.guestOnline === false;
          const roomRef = db.ref(ROOMS_PATH + '/' + id);
          if (hostOff && guestOff) {
            if (room.emptySince == null) {
              roomRef.child('emptySince').set(now);
            }
            if (room.emptySince != null && (now - room.emptySince > EMPTY_GRACE_MS)) {
              roomRef.remove();
              return;
            }
          }
          if (room.emptySince != null) {
            if (now - room.emptySince > EMPTY_GRACE_MS) {
              roomRef.remove();
              return;
            }
            return;
          }
          allRooms.push(room);
        });
      }
      allRooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      applySearchAndRender();
    });
  }

  function applySearchAndRender() {
    const query = (roomSearch.value || '').trim().toLowerCase();
    const filtered = query
      ? allRooms.filter((r) => (r.name || '').toLowerCase().includes(query))
      : allRooms;
    renderRooms(filtered);
    renderDropdown(filtered);
  }

  function renderDropdown(rooms) {
    roomDropdown.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Rooms --';
    roomDropdown.appendChild(opt);
    rooms.forEach((r) => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name || 'Unnamed';
      if (r.passwordProtected) o.textContent += ' 🔒';
      roomDropdown.appendChild(o);
    });
  }

  function deleteRoom(roomId, e) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Remove this room?')) return;
    const db = getDb();
    if (db) db.ref(ROOMS_PATH + '/' + roomId).remove();
  }

  function renderRooms(rooms) {
    roomsList.innerHTML = '';
    const admin = isAdmin();
    if (rooms.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-rooms';
      li.textContent = allRooms.length === 0 ? 'No rooms yet. Create one!' : 'No rooms match your search.';
      roomsList.appendChild(li);
      return;
    }
    rooms.forEach((room) => {
      const li = document.createElement('li');
      const name = room.name || 'Unnamed';
      const isFull = !!(room.guestId);
      const meta = room.passwordProtected ? '🔒 Password protected' : 'Open';
      const statusMeta = isFull ? 'Full (2/2)' : 'Open (1/2)';
      let actions;
      if (isFull) {
        actions = '<span class="room-full-badge">Full</span>';
      } else {
        actions = `<button type="button" class="room-join-btn" data-room-id="${escapeHtml(room.id)}" data-locked="${room.passwordProtected ? '1' : '0'}">Join</button>`;
      }
      if (admin) {
        actions = `<button type="button" class="room-delete-btn" title="Remove room" data-room-id="${escapeHtml(room.id)}">✕</button> ` + actions;
      }
      li.innerHTML = `<span><span class="room-name">${escapeHtml(name)}</span><br><span class="room-meta">${escapeHtml(meta)} · ${statusMeta}</span></span><span class="room-actions">${actions}</span>`;
      roomsList.appendChild(li);
    });
    roomsList.querySelectorAll('.room-join-btn').forEach((btn) => {
      btn.addEventListener('click', () => tryJoinRoom(btn.dataset.roomId, btn.dataset.locked === '1'));
    });
    roomsList.querySelectorAll('.room-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => deleteRoom(btn.dataset.roomId, e));
    });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function tryJoinRoom(roomId, isLocked) {
    if (getOrPromptName() == null) return;
    if (isLocked) {
      const pwd = prompt('Enter room password:');
      if (pwd === null) return;
      joinRoom(roomId, pwd);
    } else {
      joinRoom(roomId);
    }
  }

  function joinRoom(roomId, password) {
    const db = getDb();
    if (!db) {
      alert('Firebase not available.');
      return;
    }
    const ref = db.ref(ROOMS_PATH + '/' + roomId);
    ref.once('value', (snap) => {
      const room = snap.val();
      if (!room) {
        alert('Room no longer exists.');
        return;
      }
      if (room.passwordProtected && room.password !== password) {
        alert('Wrong password.');
        return;
      }
      // For now, just navigate to a multiplayer game page with room id (you can add multiplayer.html later)
      window.location.href = 'multiplayer.html?room=' + encodeURIComponent(roomId);
    });
  }

  function openCreateModal() {
    roomNameInput.value = '';
    roomPasswordLock.checked = false;
    roomPasswordInput.value = '';
    passwordField.classList.remove('visible');
    createRoomModal.classList.add('visible');
  }

  function closeCreateModal() {
    createRoomModal.classList.remove('visible');
  }

  function createRoom() {
    if (getOrPromptName() == null) return;
    const name = (roomNameInput.value || '').trim() || 'Unnamed room';
    const passwordProtected = roomPasswordLock.checked;
    const password = roomPasswordInput.value || '';

    if (passwordProtected && !password) {
      alert('Please set a password or disable password protection.');
      return;
    }

    const db = getDb();
    if (!db) {
      alert('Firebase not available.');
      return;
    }

    const myId = randomId();
    try {
      sessionStorage.setItem('triad_myId', myId);
    } catch (e) {}

    const payload = {
      name,
      passwordProtected: !!passwordProtected,
      password: passwordProtected ? password : '',
      createdAt: Date.now(),
      status: 'waiting',
      hostId: myId,
      hostOnline: true,
      guestId: null,
      guestOnline: false,
      emptySince: null,
    };

    const ref = db.ref(ROOMS_PATH).push(payload);
    const roomId = ref.key;
    closeCreateModal();
    window.location.href = 'multiplayer.html?room=' + encodeURIComponent(roomId) + '&host=1';
  }

  btnMultiplayer.addEventListener('click', showLobby);
  btnBack.addEventListener('click', () => {
    if (roomsUnsubscribe) {
      roomsUnsubscribe();
      roomsUnsubscribe = null;
    }
    showLanding();
  });

  roomSearch.addEventListener('input', applySearchAndRender);
  roomSearch.addEventListener('keyup', applySearchAndRender);

  btnCreateRoom.addEventListener('click', openCreateModal);
  btnModalCancel.addEventListener('click', closeCreateModal);
  btnModalCreate.addEventListener('click', createRoom);

  roomPasswordLock.addEventListener('change', () => {
    passwordField.classList.toggle('visible', roomPasswordLock.checked);
  });

  createRoomModal.addEventListener('click', (e) => {
    if (e.target === createRoomModal) closeCreateModal();
  });
})();
