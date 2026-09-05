const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Servidor(es) TURN — sem isso, quem está atrás de NAT restritivo/CGNAT
// (comum em 4G e redes corporativas) não consegue estabelecer a conexão
// direta de compartilhamento de tela e a tela fica preta pra sempre.
//
// Opção A (recomendada): Cloudflare Realtime TURN. Defina CF_TURN_KEY_ID e
// CF_TURN_API_TOKEN nas variáveis de ambiente do serviço de hospedagem (ex:
// Render > Environment). A API da Cloudflare usa credenciais de curta
// duração — o servidor gera uma nova a cada ~24h (nunca expõe o
// CF_TURN_API_TOKEN pro navegador, só o resultado já pronto).
//
// Opção B: qualquer outro provedor de TURN "tradicional" (usuário/senha
// fixos) via TURN_URLS (uma ou mais URLs separadas por vírgula, ex:
// "turn:seu-turn.com:3478,turn:seu-turn.com:443?transport=tcp"),
// TURN_USERNAME e TURN_CREDENTIAL.
//
// Sem nenhuma das duas configuradas, só STUN é usado — funciona pra maioria,
// mas falha pra quem precisa de um retransmissor.
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID;
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN;
const CF_TURN_TTL_SECONDS = 24 * 60 * 60; // credencial vale por 24h
let cfIceServersCache = null; // { iceServers, expiresAt }

async function getCloudflareIceServers() {
  if (cfIceServersCache && cfIceServersCache.expiresAt > Date.now()) {
    return cfIceServersCache.iceServers;
  }

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TURN_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl: CF_TURN_TTL_SECONDS })
    }
  );
  if (!res.ok) throw new Error(`Cloudflare TURN respondeu ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data.iceServers)) throw new Error('Resposta da Cloudflare sem iceServers');

  // Renova um pouco antes de expirar de verdade, pra nunca entregar credencial vencida.
  cfIceServersCache = { iceServers: data.iceServers, expiresAt: Date.now() + (CF_TURN_TTL_SECONDS - 600) * 1000 };
  return cfIceServersCache.iceServers;
}

app.get('/turn-config', async (req, res) => {
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
    try {
      return res.json({ iceServers: await getCloudflareIceServers() });
    } catch (err) {
      console.error('Falha ao gerar credenciais TURN da Cloudflare, caindo pro fallback:', err.message);
    }
  }

  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }

  res.json({ iceServers });
});

// rooms[roomId] = {
//   hostId,
//   participants: { socketId: {id, name, status} },
//   videoId, isPlaying, currentTime   <- estado do modo "YouTube" (null quando não em uso)
// }
// O vídeo de tela compartilhada NUNCA passa por aqui — trafega direto entre os
// navegadores (WebRTC). O servidor só sabe do estado do YouTube porque, nesse modo,
// múltiplas pessoas precisam ficar sincronizadas no mesmo ponto do vídeo.
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      hostId: null,
      participants: {},
      videoId: null,
      isPlaying: false,
      currentTime: 0
    };
  }
  return rooms[roomId];
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room-state', {
    hostId: room.hostId,
    videoId: room.videoId,
    participants: Object.values(room.participants)
  });
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    if (socket.data.roomId) return; // essa conexão já entrou numa sala antes
    roomId = String(roomId).trim().toLowerCase().slice(0, 60);
    name = String(name).trim().slice(0, 40);
    if (!roomId || !name) return;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    const room = getRoom(roomId);
    if (!room.hostId) room.hostId = socket.id;

    room.participants[socket.id] = { id: socket.id, name, status: 'watching' };

    socket.emit('joined', {
      youAreHost: room.hostId === socket.id,
      videoId: room.videoId,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying
    });

    broadcastRoomState(roomId);
  });

  // --- Modo YouTube ---
  socket.on('set-video', ({ videoId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;
    if (typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;

    room.videoId = videoId;
    room.isPlaying = true;
    room.currentTime = 0;

    broadcastRoomState(roomId);
    io.to(roomId).emit('playback-update', { isPlaying: true, currentTime: 0 });
  });

  socket.on('clear-video', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;

    room.videoId = null;
    room.isPlaying = false;
    room.currentTime = 0;
    broadcastRoomState(roomId);
  });

  socket.on('playback', ({ isPlaying, currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;

    room.isPlaying = isPlaying;
    room.currentTime = currentTime;
    socket.to(roomId).emit('playback-update', { isPlaying, currentTime });
  });

  socket.on('time-sync', ({ currentTime }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;

    room.currentTime = currentTime;
    socket.to(roomId).emit('time-update', { currentTime });
  });

  // --- Modo Compartilhar tela: sinalização WebRTC ---
  // Sem essas checagens, qualquer socket conectado (nem precisa estar na sala)
  // podia mandar 'webrtc-offer' pra qualquer targetId e o servidor repassava
  // sem questionar — ou seja, dava pra se passar pelo host e injetar
  // vídeo/áudio arbitrário na tela de um espectador de outra sala. Agora só
  // repassa dentro da mesma sala, e só o host de fato pode iniciar uma oferta.
  function socketInRoom(id, roomId) {
    const s = io.sockets.sockets.get(id);
    return !!s && s.data.roomId === roomId;
  }

  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return; // só o host inicia oferta
    if (!socketInRoom(targetId, roomId)) return;
    io.to(targetId).emit('webrtc-offer', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (targetId !== room.hostId) return; // resposta só pode ir pro host
    io.to(targetId).emit('webrtc-answer', { fromId: socket.id, sdp });
  });

  socket.on('webrtc-ice', ({ targetId, candidate }) => {
    if (!targetId || !candidate) return;
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id === room.hostId) {
      if (!socketInRoom(targetId, roomId)) return; // host manda pra quem é da sala
    } else if (targetId !== room.hostId) {
      return; // espectador só manda candidato de volta pro host
    }
    io.to(targetId).emit('webrtc-ice', { fromId: socket.id, candidate });
  });

  socket.on('sharing-stopped', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;
    socket.to(roomId).emit('sharing-stopped');
  });

  // Espectador percebeu que a conexão travou (sem frames chegando) e pede
  // pro host recriar a transmissão pra ele, sem precisar dar F5 na página.
  socket.on('request-resync', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || !room.hostId || socket.id === room.hostId) return;
    io.to(room.hostId).emit('request-resync', { fromId: socket.id });
  });

  // --- Comum aos dois modos ---
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
    if (!room || socket.id !== room.hostId) return;
    if (!targetId || targetId === room.hostId) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return;

    delete room.participants[targetId];
    targetSocket.emit('kicked');
    targetSocket.leave(roomId);
    targetSocket.data.roomId = null;

    broadcastRoomState(roomId);
  });

  // Host encerra a sala manualmente (sem precisar fechar a aba/desconectar).
  socket.on('close-room', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;

    io.to(roomId).emit('room-closed');
    delete rooms[roomId];
    io.socketsLeave(roomId);
    socket.data.roomId = null;
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

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
