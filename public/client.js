const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const roomNameDisplay = document.getElementById('room-name-display');
const participantList = document.getElementById('participant-list');
const participantCount = document.getElementById('participant-count');
const hostControls = document.getElementById('host-controls');
const shareBtn = document.getElementById('share-btn');
const stopShareBtn = document.getElementById('stop-share-btn');
const qualitySelect = document.getElementById('quality-select');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const remoteVideo = document.getElementById('remote-video');
const waitingMsg = document.getElementById('waiting-msg');

let socket = null;
let isHost = false;
let roomId = null;

// Configuração de conexão: STUN público, suficiente pra maioria das redes domésticas.
// (Sem servidor TURN — redes muito restritivas podem eventualmente falhar em conectar.)
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Presets de qualidade — controlam a resolução/fps capturados e o bitrate máximo
// enviado. Isso é escolhido pelo HOST porque é o upload DELE que sustenta a
// transmissão para todo mundo — quanto mais gente assistindo, mais importa manter
// isso enxuto.
const QUALITY_PRESETS = {
  economy:  { width: 1280, height: 720,  frameRate: 15, maxBitrate: 1_200_000 },
  balanced: { width: 1600, height: 900,  frameRate: 24, maxBitrate: 2_200_000 },
  high:     { width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_500_000 }
};

// --- Estado do HOST ---
let localStream = null;
let isSharing = false;
const peers = new Map(); // viewerId -> RTCPeerConnection
let knownParticipantIds = new Set();

// --- Estado do ESPECTADOR ---
let hostPeerConnection = null;
let hostSocketId = null;

// Preenche a sala automaticamente se veio na URL (?sala=xxx)
const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('sala');
if (roomFromUrl) roomInput.value = roomFromUrl;

// --- Entrada na sala ---
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const room = roomInput.value.trim().toLowerCase();
  if (!name || !room) return;
  roomId = room;

  socket = io();

  socket.on('connect', () => {
    socket.emit('join-room', { roomId, name });
  });

  socket.on('joined', ({ youAreHost }) => {
    isHost = youAreHost;
    hostControls.classList.toggle('hidden', !isHost);
    joinScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    roomNameDisplay.textContent = roomId;
  });

  socket.on('room-state', (state) => {
    renderParticipants(state.participants, state.hostId);
    hostSocketId = state.hostId;

    const currentIds = new Set(state.participants.map((p) => p.id));

    if (isHost && isSharing) {
      // Conecta automaticamente com quem entrou na sala depois que a transmissão já começou.
      currentIds.forEach((id) => {
        if (id !== socket.id && !peers.has(id)) createOfferFor(id);
      });
      // Libera a conexão de quem saiu da sala.
      knownParticipantIds.forEach((id) => {
        if (!currentIds.has(id) && peers.has(id)) {
          peers.get(id).close();
          peers.delete(id);
        }
      });
    }
    knownParticipantIds = currentIds;
  });

  // --- Sinalização WebRTC (comum a host e espectador) ---
  socket.on('webrtc-offer', async ({ fromId, sdp }) => {
    await handleIncomingOffer(fromId, sdp);
  });

  socket.on('webrtc-answer', async ({ fromId, sdp }) => {
    const pc = peers.get(fromId);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on('webrtc-ice', async ({ fromId, candidate }) => {
    const pc = isHost ? peers.get(fromId) : hostPeerConnection;
    if (!pc) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      // candidatos que chegam fora de ordem podem falhar silenciosamente, sem problema
    }
  });

  socket.on('sharing-stopped', () => {
    clearRemoteVideo();
  });

  socket.on('room-closed', () => {
    alert('O host fechou a sala.');
    window.location.href = window.location.pathname;
  });

  socket.on('kicked', () => {
    alert('Você foi expulso.');
    window.location.href = window.location.pathname;
  });
});

// ============================================================
// HOST: iniciar / parar / gerenciar a transmissão
// ============================================================

shareBtn.addEventListener('click', async () => {
  const preset = QUALITY_PRESETS[qualitySelect.value] || QUALITY_PRESETS.balanced;
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate }
      },
      audio: true // som do sistema/aba — suporte varia por navegador/SO
    });
  } catch (err) {
    // usuário cancelou a janela de seleção de tela, ou o navegador negou permissão
    return;
  }

  isSharing = true;
  shareBtn.classList.add('hidden');
  stopShareBtn.classList.remove('hidden');
  qualitySelect.disabled = true;

  // Se o host parar a transmissão clicando no botão nativo do navegador
  // ("Parar compartilhamento"), detectamos aqui e encerramos tudo do nosso lado também.
  localStream.getVideoTracks()[0].addEventListener('ended', stopSharing);

  knownParticipantIds.forEach((id) => {
    if (id !== socket.id) createOfferFor(id);
  });
});

stopShareBtn.addEventListener('click', stopSharing);

function stopSharing() {
  if (!isSharing) return;
  isSharing = false;

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  peers.forEach((pc) => pc.close());
  peers.clear();

  shareBtn.classList.remove('hidden');
  stopShareBtn.classList.add('hidden');
  qualitySelect.disabled = false;

  socket.emit('sharing-stopped');
}

function createOfferFor(viewerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(viewerId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  applyBitrateLimit(pc);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('webrtc-ice', { targetId: viewerId, candidate: e.candidate });
  };

  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => {
      socket.emit('webrtc-offer', { targetId: viewerId, sdp: pc.localDescription });
    });
}

function applyBitrateLimit(pc) {
  const preset = QUALITY_PRESETS[qualitySelect.value] || QUALITY_PRESETS.balanced;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings) params.encodings = [{}];
  params.encodings[0].maxBitrate = preset.maxBitrate;
  sender.setParameters(params).catch(() => {});
}

// ============================================================
// ESPECTADOR: receber a oferta do host e responder
// ============================================================

async function handleIncomingOffer(fromId, sdp) {
  // Só espectadores recebem ofertas (o host nunca recebe oferta de ninguém).
  if (isHost) return;

  if (hostPeerConnection) {
    hostPeerConnection.close();
    hostPeerConnection = null;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  hostPeerConnection = pc;

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    waitingMsg.classList.add('hidden');
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('webrtc-ice', { targetId: fromId, candidate: e.candidate });
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { targetId: fromId, sdp: pc.localDescription });
}

function clearRemoteVideo() {
  if (hostPeerConnection) {
    hostPeerConnection.close();
    hostPeerConnection = null;
  }
  remoteVideo.srcObject = null;
  waitingMsg.classList.remove('hidden');
}

// --- Tela cheia (disponível para todos) ---
fullscreenBtn.addEventListener('click', () => {
  const el = isHost ? null : remoteVideo; // host não tem vídeo próprio pra exibir em tela cheia
  const target = el || document.querySelector('.player-wrap');
  if (target.requestFullscreen) target.requestFullscreen();
  else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
  else if (target.mozRequestFullScreen) target.mozRequestFullScreen();
  else if (target.msRequestFullscreen) target.msRequestFullscreen();
});

// --- Lista de participantes ---
function renderParticipants(participants, hostId) {
  participantCount.textContent = participants.length;
  participantList.innerHTML = '';
  participants.forEach((p) => {
    const li = document.createElement('li');
    const statusClass = p.status === 'watching' ? 'status-watching' : 'status-away';
    const statusLabel = p.status === 'watching' ? 'Assistindo' : 'Ausente';
    const hostTag = p.id === hostId ? '<span class="host-tag">HOST</span>' : '';
    const showKick = isHost && p.id !== hostId;
    const kickBtn = showKick ? `<button type="button" class="kick-btn" data-id="${p.id}">Expulsar</button>` : '';

    li.innerHTML = `
      <span class="participant-name">${escapeHtml(p.name)}${hostTag}</span>
      <span class="participant-right">
        <span class="status-badge ${statusClass}">${statusLabel}</span>
        ${kickBtn}
      </span>
    `;
    participantList.appendChild(li);
  });
}

participantList.addEventListener('click', (e) => {
  const btn = e.target.closest('.kick-btn');
  if (!btn || !socket) return;
  const targetId = btn.dataset.id;
  if (!targetId) return;
  socket.emit('kick', { targetId });
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Detecção de presença (troca de aba / minimizar) ---
document.addEventListener('visibilitychange', () => {
  if (!socket) return;
  socket.emit('visibility', { hidden: document.hidden });
});
