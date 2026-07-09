// ============================================================
// TURNCOAT — Milestone 5 server
// New in M4: the Turncoat. One hider is secretly working for
// the seeker: they can LEAK everyone's position once per round.
// Hiders get one emergency vote to eject the traitor — but
// ejecting an innocent exposes them to the seeker.
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Game settings (tweak freely!) ----------------
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const HIDE_SECONDS = 30;
const SEEK_SECONDS = 150;
const TAG_DISTANCE = 2.6;
const TAG_COOLDOWN_MS = 700;
const WHIFF_STUN_MS = 2000;
const RESULTS_SECONDS = 9;

// Turncoat settings
const MIN_HIDERS_FOR_TURNCOAT = 2; // 2 = testable with 3 players; feels best with 4+ hiders
const LEAK_SECONDS = 4;            // how long the leak shows hider positions to the seeker
const VOTE_SECONDS = 25;           // how long the emergency vote lasts
const EXPOSE_SECONDS = 8;          // innocent ejected = tracked by seeker this long

const SHAPES = ['char', 'crate', 'rock', 'pillar'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const rooms = {};
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PLAYER_COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#457b9d', '#f4a261',
  '#9b5de5', '#00b4d8', '#ef476f', '#80b918', '#ff9f1c'
];

function makeRoomCode() {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  } while (rooms[code]);
  return code;
}

function cleanName(raw) {
  const name = String(raw || '').replace(/[^\w \-']/g, '').trim().slice(0, 12);
  return name.length ? name : 'Player';
}

function randomSpawn() {
  return { x: (Math.random() - 0.5) * 16, y: 0, z: (Math.random() - 0.5) * 16 };
}

function defaultSkin() {
  return { shape: 'char', color: null };
}

function roomSnapshot(room) {
  return { state: room.state, hostId: room.hostId, players: room.players };
}

function clearTimers(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
  if (room.seekTimer) { clearTimeout(room.seekTimer); room.seekTimer = null; }
  if (room.voteTimer) { clearTimeout(room.voteTimer); room.voteTimer = null; }
}

function livingHiders(room) {
  return Object.values(room.players).filter((p) => p.role === 'hider' && p.alive);
}

// ---------------- Round flow ----------------
function startGame(code) {
  const room = rooms[code];
  if (!room) return;

  const ids = Object.keys(room.players);
  const seekerId = ids[Math.floor(Math.random() * ids.length)];

  ids.forEach((id) => {
    const p = room.players[id];
    p.role = id === seekerId ? 'seeker' : 'hider';
    p.alive = true;
    p.skin = defaultSkin();
    p.stunnedUntil = 0;
    const s = randomSpawn();
    p.x = s.x; p.y = 0; p.z = s.z; p.ry = 0;
  });
  const seeker = room.players[seekerId];
  seeker.x = 0; seeker.z = 0;

  // Secretly pick the Turncoat among the hiders.
  // IMPORTANT: this is stored on the room, NOT on the player object,
  // so it is never broadcast to everyone by accident.
  const hiderIds = ids.filter((id) => id !== seekerId);
  room.turncoatId = null;
  if (hiderIds.length >= MIN_HIDERS_FOR_TURNCOAT) {
    room.turncoatId = hiderIds[Math.floor(Math.random() * hiderIds.length)];
  }
  room.turncoatEjected = false;
  room.leakUsed = false;
  room.voteUsed = false;
  room.voting = false;
  room.votes = {};

  room.state = 'hide';
  room.seekerId = seekerId;
  clearTimers(room);

  io.to(code).emit('gameStarted', {
    seekerId,
    hideSeconds: HIDE_SECONDS,
    seekSeconds: SEEK_SECONDS,
    turncoatActive: !!room.turncoatId, // everyone knows a snake exists — not who
    players: room.players
  });
  // Only the Turncoat learns their secret
  if (room.turncoatId) {
    io.to(room.turncoatId).emit('youAreTurncoat', { leakSeconds: LEAK_SECONDS });
  }
  console.log(`[room ${code}] round started — seeker: ${seeker.name}` +
    (room.turncoatId ? `, turncoat: ${room.players[room.turncoatId].name}` : ', no turncoat'));

  room.timers.push(setTimeout(() => {
    if (!rooms[code] || room.state !== 'hide') return;
    room.state = 'seek';
    room.seekEndsAt = Date.now() + SEEK_SECONDS * 1000;
    io.to(code).emit('phaseChanged', { phase: 'seek', seconds: SEEK_SECONDS });
    armSeekTimer(code);
  }, HIDE_SECONDS * 1000));
}

// The seek countdown lives in its own timer so votes can pause/resume it
function armSeekTimer(code) {
  const room = rooms[code];
  if (!room) return;
  const remaining = room.seekEndsAt - Date.now();
  room.seekTimer = setTimeout(() => {
    if (!rooms[code] || room.state !== 'seek' || room.voting) return;
    endGame(code, 'hiders');
  }, Math.max(0, remaining));
}

function endGame(code, winner) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'over';
  room.voting = false;
  clearTimers(room);

  const survivors = Object.values(room.players)
    .filter((p) => p.role === 'hider' && p.alive)
    .map((p) => p.name);
  const seeker = room.players[room.seekerId];
  const turncoat = room.turncoatId ? room.players[room.turncoatId] : null;
  const turncoatWon = !!turncoat && winner === 'seeker' && !room.turncoatEjected;

  // Session scoreboard awards
  Object.values(room.players).forEach((p) => {
    if (p.role === 'hider' && p.alive && !(turncoat && p.id === turncoat.id)) p.score += 2; // survived
  });
  if (winner === 'seeker' && seeker) seeker.score += 2;   // clean sweep bonus
  if (turncoatWon) turncoat.score += 3;                    // betrayal pays

  io.to(code).emit('gameOver', {
    winner,
    seekerName: seeker ? seeker.name : '???',
    survivors,
    turncoatName: turncoat ? turncoat.name : null,
    turncoatWon
  });
  console.log(`[room ${code}] round over — ${winner} win` +
    (turncoat ? ` (turncoat ${turncoat.name} ${turncoatWon ? 'WON' : 'lost'})` : ''));

  room.timers.push(setTimeout(() => {
    if (!rooms[code]) return;
    room.state = 'lobby';
    room.seekerId = null;
    room.turncoatId = null;
    Object.values(room.players).forEach((p) => {
      p.role = null; p.alive = true; p.skin = defaultSkin();
    });
    io.to(code).emit('backToLobby', roomSnapshot(room));
  }, RESULTS_SECONDS * 1000));
}

function checkRoundAfterLeave(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.state !== 'hide' && room.state !== 'seek') return;

  const players = Object.values(room.players);
  const seekerGone = !room.players[room.seekerId];

  if (players.length < 2 || seekerGone) endGame(code, 'hiders');
  else if (livingHiders(room).length === 0) endGame(code, 'seeker');
  else if (room.voting) maybeFinishVoteEarly(code);
}

// ---------------- Emergency vote ----------------
function startVote(code, callerId) {
  const room = rooms[code];
  if (!room) return;
  const caller = room.players[callerId];

  room.voting = true;
  room.voteUsed = true;
  room.votes = {};

  // Pause the seek countdown while everyone argues
  room.pausedRemaining = Math.max(0, room.seekEndsAt - Date.now());
  if (room.seekTimer) { clearTimeout(room.seekTimer); room.seekTimer = null; }

  const candidates = livingHiders(room).map((p) => ({ id: p.id, name: p.name, color: p.color }));

  io.to(code).emit('voteStarted', {
    callerName: caller ? caller.name : '???',
    candidates,
    seconds: VOTE_SECONDS
  });
  console.log(`[room ${code}] emergency vote called by ${caller ? caller.name : '???'}`);

  room.voteTimer = setTimeout(() => finishVote(code), VOTE_SECONDS * 1000);
}

function maybeFinishVoteEarly(code) {
  const room = rooms[code];
  if (!room || !room.voting) return;
  const voters = livingHiders(room);
  const allVoted = voters.every((p) => room.votes[p.id] !== undefined);
  if (allVoted) finishVote(code);
}

function finishVote(code) {
  const room = rooms[code];
  if (!room || !room.voting) return;
  if (room.voteTimer) { clearTimeout(room.voteTimer); room.voteTimer = null; }
  room.voting = false;

  // Tally: the option with strictly the most votes wins; skip is an option; ties = nobody
  const tally = {};
  Object.values(room.votes).forEach((t) => { tally[t] = (tally[t] || 0) + 1; });
  let best = null, bestCount = 0, tie = false;
  Object.entries(tally).forEach(([target, count]) => {
    if (count > bestCount) { best = target; bestCount = count; tie = false; }
    else if (count === bestCount) tie = true;
  });

  let result = { ejectedId: null, ejectedName: null, wasTurncoat: false };
  const target = (!tie && best && best !== 'skip') ? room.players[best] : null;

  if (target && target.role === 'hider' && target.alive) {
    result.ejectedId = target.id;
    result.ejectedName = target.name;

    if (target.id === room.turncoatId) {
      // Got the snake!
      result.wasTurncoat = true;
      target.alive = false;
      target.skin = defaultSkin();
      room.turncoatEjected = true;
    } else {
      // Innocent. They stay in the game… but the seeker now knows where they are.
      io.to(room.seekerId).emit('exposedHider', { id: target.id, seconds: EXPOSE_SECONDS });
    }
  }

  // Resume the hunt
  room.seekEndsAt = Date.now() + room.pausedRemaining;
  result.resumeSeconds = room.pausedRemaining / 1000;
  io.to(code).emit('voteResult', result);
  armSeekTimer(code);

  // If ejecting the turncoat emptied the hider side, the seeker takes it
  if (livingHiders(room).length === 0) endGame(code, 'seeker');
}

// ---------------- Connections ----------------
io.on('connection', (socket) => {
  let roomCode = null;
  let lastTagAt = 0;
  let lastSkinAt = 0;

  function addPlayerToRoom(code, rawName, respond) {
    const room = rooms[code];
    if (!room) return respond({ error: 'Room not found. Check the code and try again.' });
    if (Object.keys(room.players).length >= MAX_PLAYERS) return respond({ error: 'That room is full (10 players max).' });
    if (room.state !== 'lobby') return respond({ error: 'A round is in progress — try again in a couple of minutes.' });

    const spawn = randomSpawn();
    const usedColors = Object.values(room.players).map((p) => p.color);
    const color = PLAYER_COLORS.find((c) => !usedColors.includes(c)) || PLAYER_COLORS[0];

    const player = {
      id: socket.id,
      name: cleanName(rawName),
      color,
      x: spawn.x, y: 0, z: spawn.z, ry: 0,
      role: null,
      alive: true,
      skin: defaultSkin(),
      stunnedUntil: 0,
      score: 0
    };

    room.players[socket.id] = player;
    if (!room.hostId) room.hostId = socket.id;
    socket.join(code);
    roomCode = code;

    respond({ code, you: player, room: roomSnapshot(room) });
    socket.to(code).emit('playerJoined', player);
    io.to(code).emit('hostIs', room.hostId);
    console.log(`[room ${code}] ${player.name} joined (${Object.keys(room.players).length})`);
  }

  socket.on('createRoom', (rawName, respond) => {
    if (typeof respond !== 'function') return;
    const code = makeRoomCode();
    rooms[code] = {
      players: {}, hostId: null, state: 'lobby', seekerId: null, timers: [],
      turncoatId: null, turncoatEjected: false, leakUsed: false,
      voteUsed: false, voting: false, votes: {}, seekTimer: null, voteTimer: null,
      seekEndsAt: 0, pausedRemaining: 0
    };
    console.log(`[room ${code}] created`);
    addPlayerToRoom(code, rawName, respond);
  });

  socket.on('joinRoom', (data, respond) => {
    if (typeof respond !== 'function') return;
    const code = String((data && data.code) || '').toUpperCase().trim();
    addPlayerToRoom(code, data && data.name, respond);
  });

  socket.on('startGame', () => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'lobby') return;
    if (socket.id !== room.hostId) return;
    if (Object.keys(room.players).length < MIN_PLAYERS) return;
    startGame(roomCode);
  });

  socket.on('move', (data) => {
    const room = rooms[roomCode];
    if (!room || !data) return;
    const player = room.players[socket.id];
    if (!player) return;
    if (!player.alive) return;
    if (room.voting) return; // everyone freezes during the huddle
    if (room.state === 'hide' && player.role === 'seeker') return;
    if (player.stunnedUntil && Date.now() < player.stunnedUntil) return;

    player.x = Number(data.x) || 0;
    player.y = Number(data.y) || 0;
    player.z = Number(data.z) || 0;
    player.ry = Number(data.ry) || 0;

    socket.to(roomCode).volatile.emit('playerMoved', {
      id: socket.id, x: player.x, y: player.y, z: player.z, ry: player.ry
    });
  });

  socket.on('setSkin', (data) => {
    const room = rooms[roomCode];
    if (!room || !data) return;
    const player = room.players[socket.id];
    if (!player || player.role !== 'hider' || !player.alive) return;
    if (room.state !== 'hide' && room.state !== 'seek') return;
    if (room.voting) return;

    const now = Date.now();
    if (now - lastSkinAt < 150) return;
    lastSkinAt = now;

    const shape = SHAPES.includes(data.shape) ? data.shape : 'char';
    const color = (typeof data.color === 'string' && HEX_COLOR.test(data.color)) ? data.color : null;

    player.skin = { shape, color };
    socket.to(roomCode).emit('skinChanged', { id: socket.id, skin: player.skin });
  });

  // Turncoat sabotage: leak every hider's position to the seeker
  socket.on('useLeak', () => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'seek' || room.voting) return;
    if (socket.id !== room.turncoatId) return;      // only the snake
    if (room.leakUsed) return;                       // once per round
    const turncoat = room.players[socket.id];
    if (!turncoat || !turncoat.alive) return;

    room.leakUsed = true;
    const ids = livingHiders(room).filter((p) => p.id !== socket.id).map((p) => p.id);

    io.to(room.seekerId).emit('leakInfo', { ids, seconds: LEAK_SECONDS });
    socket.emit('leakConfirmed');
    // Everyone else hears... something. Paranoia fuel.
    Object.values(room.players).forEach((p) => {
      if (p.id !== room.seekerId && p.id !== socket.id) {
        io.to(p.id).emit('staticNoise');
      }
    });
    console.log(`[room ${roomCode}] the turncoat leaked positions`);
  });

  // A hider slams the emergency button
  socket.on('callVote', () => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'seek' || room.voting || room.voteUsed) return;
    if (!room.turncoatId) return; // no turncoat this round, nothing to vote about
    const player = room.players[socket.id];
    if (!player || player.role !== 'hider' || !player.alive) return;
    startVote(roomCode, socket.id);
  });

  socket.on('castVote', (data) => {
    const room = rooms[roomCode];
    if (!room || !room.voting || !data) return;
    const voter = room.players[socket.id];
    if (!voter || voter.role !== 'hider' || !voter.alive) return;
    if (room.votes[socket.id] !== undefined) return; // one vote each

    const target = data.targetId === 'skip' ? 'skip' : String(data.targetId || '');
    if (target !== 'skip') {
      const t = room.players[target];
      if (!t || t.role !== 'hider' || !t.alive) return;
    }
    room.votes[socket.id] = target;
    io.to(roomCode).emit('voteProgress', {
      voted: Object.keys(room.votes).length,
      total: livingHiders(room).length
    });
    maybeFinishVoteEarly(roomCode);
  });

  socket.on('tryTag', () => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'seek' || room.voting) return;
    const seeker = room.players[socket.id];
    if (!seeker || seeker.role !== 'seeker') return;

    const now = Date.now();
    if (now - lastTagAt < TAG_COOLDOWN_MS) return;
    if (seeker.stunnedUntil && now < seeker.stunnedUntil) return;
    lastTagAt = now;

    let closest = null;
    let closestDist = TAG_DISTANCE;
    Object.values(room.players).forEach((p) => {
      if (p.role !== 'hider' || !p.alive) return;
      const dist = Math.hypot(p.x - seeker.x, p.z - seeker.z);
      if (dist < closestDist) { closest = p; closestDist = dist; }
    });

    if (!closest) {
      seeker.stunnedUntil = now + WHIFF_STUN_MS;
      io.to(roomCode).emit('seekerWhiffed', { seconds: WHIFF_STUN_MS / 1000 });
      return;
    }

    closest.alive = false;
    closest.skin = defaultSkin();
    seeker.score += 1; // +1 per catch
    io.to(roomCode).emit('playerTagged', { id: closest.id, name: closest.name });
    console.log(`[room ${roomCode}] ${closest.name} was tagged`);

    if (livingHiders(room).length === 0) endGame(roomCode, 'seeker');
  });

  socket.on('disconnect', () => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    delete room.players[socket.id];
    socket.to(roomCode).emit('playerLeft', socket.id);

    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.players)[0] || null;
      if (room.hostId) io.to(roomCode).emit('hostIs', room.hostId);
    }

    if (player) console.log(`[room ${roomCode}] ${player.name} left (${Object.keys(room.players).length})`);

    if (Object.keys(room.players).length === 0) {
      clearTimers(room);
      delete rooms[roomCode];
      console.log(`[room ${roomCode}] closed (empty)`);
    } else {
      checkRoundAfterLeave(roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('TURNCOAT server (Milestone 5) running!');
  console.log(`Open http://localhost:${PORT} in your browser to play.`);
});
