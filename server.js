const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = { hostId, participants: { socketId: {id, name, status} } }
// Não guardamos nenhum estado de vídeo aqui — o vídeo trafega DIRETO entre o
// navegador do host e o de cada espectador (WebRTC). O servidor só ajuda a
// "apresentar" os dois lados um ao outro (troca de SDP/ICE) e a gerenciar a sala.
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { hostId: null, participants: {} };
  }
  return rooms[roomId];
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room-state', {
    hostId: room.hostId,
    participants: Object.values(room.participants)
  });
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    roomId = String(roomId).trim().toLowerCase();
    name = String(name).trim().slice(0, 40);
    if (!roomId || !name) return;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    const room = getRoom(roomId);
    if (!room.hostId) room.hostId = socket.id;

    room.participants[socket.id] = { id: socket.id, name, status: 'watching' };

    socket.emit('joined', { youAreHost: room.hostId === socket.id });
    broadcastRoomState(roomId);
  });

  // --- Sinalização WebRTC: o servidor só repassa a mensagem para o destinatário certo ---
  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('webrtc-offer', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('webrtc-answer', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-ice', ({ targetId, candidate }) => {
    if (!targetId || !candidate) return;
    io.to(targetId).emit('webrtc-ice', { fromId: socket.id, candidate });
  });

  // Host avisa que parou de compartilhar — servidor repassa pra sala inteira.
  socket.on('sharing-stopped', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;
    socket.to(roomId).emit('sharing-stopped');
  });

  socket.on('visibility', ({ hidden }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    const p = room.participants[socket.id];
    if (p) {
      p.status = hidden ? 'away' : 'watching';
      broadcastRoomState(roomId);
    }
  });

  socket.on('kick', ({ targetId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return; // só o host expulsa
    if (!targetId || targetId === room.hostId) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return;

    delete room.participants[targetId];
    targetSocket.emit('kicked');
    targetSocket.leave(roomId);
    targetSocket.data.roomId = null;

    broadcastRoomState(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    // Se quem saiu era o host, a sala é fechada para todo mundo.
    if (room.hostId === socket.id) {
      io.to(roomId).emit('room-closed');
      delete rooms[roomId];
      io.socketsLeave(roomId);
      return;
    }

    delete room.participants[socket.id];
    if (Object.keys(room.participants).length === 0) {
      delete rooms[roomId];
    } else {
      broadcastRoomState(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
