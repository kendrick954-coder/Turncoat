// ============================================================
// TURNCOAT — Milestone 2 server
// New in M2: lobby with host, Seeker/Hider roles, hide phase,
// seek phase with countdown, tagging, and win conditions.
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
const MIN_PLAYERS = 2;        // 2 lets you test alone with two tabs; 3+ is the real game
const HIDE_SECONDS = 20;      // hiders get this long before the seeker is released
const SEEK_SECONDS = 120;     // seeker has this long to find everyone
const TAG_DISTANCE = 2.4;     // how close the seeker must be to tag (in world units)
const TAG_COOLDOWN_MS = 700;  // stops tag-button spamming
const RESULTS_SECONDS = 7;    // how long the win screen shows before returning to lobby

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

// A safe summary of the room to send to clients (no internal timers etc.)
function roomSnapshot(room) {
  return {
    state: room.state,
    hostId: room.hostId,
    players: room.players
  };
}

function clearTimers(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
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
    const s = randomSpawn();
    p.x = s.x; p.y = 0; p.z = s.z; p.ry = 0;
  });
  // Seeker starts at the center, facing the arena
  const seeker = room.players[seekerId];
  seeker.x = 0; seeker.z = 0;

  room.state = 'hide';
  room.seekerId = seekerId;
  clearTimers(room);

  io.to(code).emit('gameStarted', {
    seekerId,
    hideSeconds: HIDE_SECONDS,
    seekSeconds: SEEK_SECONDS,
    players: room.players
  });
  console.log(`[room ${code}] round started — seeker: ${seeker.name}`);

  // Hide phase ends -> seek phase begins
  room.timers.push(setTimeout(() => {
    if (!rooms[code] || room.state !== 'hide') return;
    room.state = 'seek';
    io.to(code).emit('phaseChanged', { phase: 'seek', seconds: SEEK_SECONDS });

    // Seek phase ends -> any hider still alive means hiders win
    room.timers.push(setTimeout(() => {
      if (!rooms[code] || room.state !== 'seek') return;
      endGame(code, 'hiders');
    }, SEEK_SECONDS * 1000));
  }, HIDE_SECONDS * 1000));
}

function endGame(code, winner) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'over';
  clearTimers(room);

  const survivors = Object.values(room.players)
    .filter((p) => p.role === 'hider' && p.alive)
    .map((p) => p.name);
  const seeker = room.players[room.seekerId];

  io.to(code).emit('gameOver', {
    winner, // 'seeker' or 'hiders'
    seekerName: seeker ? seeker.name : '???',
    survivors
  });
  console.log(`[room ${code}] round over — ${winner} win`);

  // Back to the lobby after the results screen
  room.timers.push(setTimeout(() => {
    if (!rooms[code]) return;
    room.state = 'lobby';
    room.seekerId = null;
    Object.values(room.players).forEach((p) => { p.role = null; p.alive = true; });
    io.to(code).emit('backToLobby', roomSnapshot(room));
  }, RESULTS_SECONDS * 1000));
}

// If someone leaves mid-round, make sure the round still makes sense
function checkRoundAfterLeave(code) {
  const room = rooms[code];
  if (!room) return;
  const inRound = room.state === 'hide' || room.state === 'seek';
  if (!inRound) return;

  const players = Object.values(room.players);
  const seekerGone = !room.players[room.seekerId];
  const aliveHiders = players.filter((p) => p.role === 'hider' && p.alive);

  if (players.length < 2 || seekerGone) {
    endGame(code, 'hiders'); // seeker rage-quit counts as a hider win :)
  } else if (aliveHiders.length === 0) {
    endGame(code, 'seeker');
  }
}

// ---------------- Connections ----------------
io.on('connection', (socket) => {
  let roomCode = null;
  let lastTagAt = 0;

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
      role: null,   // 'seeker' | 'hider' | null in lobby
      alive: true
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
    rooms[code] = { players: {}, hostId: null, state: 'lobby', seekerId: null, timers: [] };
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
    if (socket.id !== room.hostId) return; // only the host can start
    if (Object.keys(room.players).length < MIN_PLAYERS) return;
    startGame(roomCode);
  });

  socket.on('move', (data) => {
    const room = rooms[roomCode];
    if (!room || !data) return;
    const player = room.players[socket.id];
    if (!player) return;
    // Tagged players are frozen; the seeker is frozen during the hide phase
    if (!player.alive) return;
    if (room.state === 'hide' && player.role === 'seeker') return;

    player.x = Number(data.x) || 0;
    player.y = Number(data.y) || 0;
    player.z = Number(data.z) || 0;
    player.ry = Number(data.ry) || 0;

    socket.to(roomCode).volatile.emit('playerMoved', {
      id: socket.id, x: player.x, y: player.y, z: player.z, ry: player.ry
    });
  });

  // Seeker pressed the TAG button — the server decides if it counts,
  // so nobody can cheat by editing their own game page.
  socket.on('tryTag', () => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'seek') return;
    const seeker = room.players[socket.id];
    if (!seeker || seeker.role !== 'seeker') return;

    const now = Date.now();
    if (now - lastTagAt < TAG_COOLDOWN_MS) return;
    lastTagAt = now;

    // Find the closest living hider within reach
    let closest = null;
    let closestDist = TAG_DISTANCE;
    Object.values(room.players).forEach((p) => {
      if (p.role !== 'hider' || !p.alive) return;
      const dist = Math.hypot(p.x - seeker.x, p.z - seeker.z);
      if (dist < closestDist) { closest = p; closestDist = dist; }
    });

    if (!closest) return;
    closest.alive = false;
    io.to(roomCode).emit('playerTagged', { id: closest.id, name: closest.name });
    console.log(`[room ${roomCode}] ${closest.name} was tagged`);

    const anyLeft = Object.values(room.players).some((p) => p.role === 'hider' && p.alive);
    if (!anyLeft) endGame(roomCode, 'seeker');
  });

  socket.on('disconnect', () => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    delete room.players[socket.id];
    socket.to(roomCode).emit('playerLeft', socket.id);

    // Pass host to someone else if the host left
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
  console.log('TURNCOAT server (Milestone 2) running!');
  console.log(`Open http://localhost:${PORT} in your browser to play.`);
});
