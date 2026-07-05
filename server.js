// ============================================================
// TURNCOAT — Milestone 1 server
// Handles: serving the game page, rooms with 4-letter codes,
// and relaying player positions to everyone in the same room.
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve everything inside the /public folder (the game page)
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// Room storage (in memory — resets if the server restarts)
// rooms = { "ABCD": { players: { socketId: playerData } } }
// ------------------------------------------------------------
const rooms = {};

const MAX_PLAYERS = 10;

// Letters that are easy to read out loud (no O/0 or I/1 confusion)
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// Distinct player colors, assigned in order of joining
const PLAYER_COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#457b9d', '#f4a261',
  '#9b5de5', '#00b4d8', '#ef476f', '#80b918', '#ff9f1c'
];

function makeRoomCode() {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    }
  } while (rooms[code]); // extremely unlikely collision, but be safe
  return code;
}

function cleanName(raw) {
  const name = String(raw || '').replace(/[^\w \-']/g, '').trim().slice(0, 12);
  return name.length ? name : 'Player';
}

function randomSpawn() {
  // Random point in the middle area of the arena
  return {
    x: (Math.random() - 0.5) * 16,
    y: 0,
    z: (Math.random() - 0.5) * 16
  };
}

// ------------------------------------------------------------
// Socket.io — one connection per player
// ------------------------------------------------------------
io.on('connection', (socket) => {
  let roomCode = null; // which room this player is in

  function addPlayerToRoom(code, rawName, respond) {
    const room = rooms[code];
    if (!room) {
      return respond({ error: 'Room not found. Check the code and try again.' });
    }
    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      return respond({ error: 'That room is full (10 players max).' });
    }

    const spawn = randomSpawn();
    const usedColors = Object.values(room.players).map((p) => p.color);
    const color =
      PLAYER_COLORS.find((c) => !usedColors.includes(c)) || PLAYER_COLORS[0];

    const player = {
      id: socket.id,
      name: cleanName(rawName),
      color,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      ry: 0 // which way the player is facing
    };

    room.players[socket.id] = player;
    socket.join(code);
    roomCode = code;

    // Tell the new player about the room, and the room about the new player
    respond({ code, you: player, players: room.players });
    socket.to(code).emit('playerJoined', player);
    console.log(`[room ${code}] ${player.name} joined (${Object.keys(room.players).length} players)`);
  }

  socket.on('createRoom', (rawName, respond) => {
    if (typeof respond !== 'function') return;
    const code = makeRoomCode();
    rooms[code] = { players: {} };
    console.log(`[room ${code}] created`);
    addPlayerToRoom(code, rawName, respond);
  });

  socket.on('joinRoom', (data, respond) => {
    if (typeof respond !== 'function') return;
    const code = String((data && data.code) || '').toUpperCase().trim();
    addPlayerToRoom(code, data && data.name, respond);
  });

  // Player moved — remember it and relay to everyone else in the room.
  // "volatile" = if a packet is dropped, don't bother resending an old position.
  socket.on('move', (data) => {
    if (!roomCode || !rooms[roomCode]) return;
    const player = rooms[roomCode].players[socket.id];
    if (!player || !data) return;

    player.x = Number(data.x) || 0;
    player.y = Number(data.y) || 0;
    player.z = Number(data.z) || 0;
    player.ry = Number(data.ry) || 0;

    socket.to(roomCode).volatile.emit('playerMoved', {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      ry: player.ry
    });
  });

  socket.on('disconnect', () => {
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    const player = room.players[socket.id];
    delete room.players[socket.id];
    socket.to(roomCode).emit('playerLeft', socket.id);

    if (player) {
      console.log(`[room ${roomCode}] ${player.name} left (${Object.keys(room.players).length} players)`);
    }
    // Delete empty rooms so codes can be reused
    if (Object.keys(room.players).length === 0) {
      delete rooms[roomCode];
      console.log(`[room ${roomCode}] closed (empty)`);
    }
  });
});

// ------------------------------------------------------------
// Start the server. Hosting services set PORT for us;
// on your own computer it defaults to 3000.
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('TURNCOAT server running!');
  console.log(`Open http://localhost:${PORT} in your browser to play.`);
});
