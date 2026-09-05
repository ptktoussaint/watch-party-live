const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const roomNameDisplay = document.getElementById('room-name-display');
const participantList = document.getElementById('participant-list');
const participantCount = document.getElementById('participant-count');
const hostControls = document.getElementById('host-controls');
const closeRoomBtn = document.getElementById('close-room-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const waitingMsg = document.getElementById('waiting-msg');

// Modo YouTube
const ytContainer = document.getElementById('yt-container');
const playerBlock = document.getElementById('player-block');
const ytQualitySelect = document.getElementById('yt-quality-select');
const videoUrlInput = document.getElementById('video-url-input');
const loadVideoBtn = document.getElementById('load-video-btn');

// Modo Compartilhar tela
const remoteVideo = document.getElementById('remote-video');
const unlockAudioBtn = document.getElementById('unlock-audio-btn');
const screenQualitySelect = document.getElementById('screen-quality-select');
const shareBtn = document.getElementById('share-btn');
const stopShareBtn = document.getElementById('stop-share-btn');

// Abas do host
const tabScreenBtn = document.getElementById('tab-screen-btn');
const tabYoutubeBtn = document.getElementById('tab-youtube-btn');
const hostScreenPanel = document.getElementById('host-screen-panel');
const hostYoutubePanel = document.getElementById('host-youtube-panel');

let socket = null;
let isHost = false;
let roomId = null;
let activeHostTab = 'screen';

// --- Estado do modo YouTube ---
let player = null;
let ytApiReady = false;
let playerReady = false;
let currentVideoId = null;
let pendingInitialState = null;
let applyingRemoteState = false; // evita re-emitir eventos que vieram do servidor
let timeSyncInterval = null;
let lastKnownState = { isPlaying: false, currentTime: 0 };

// --- Estado do modo Compartilhar tela ---
// Só STUN não é suficiente: quem está atrás de NAT restritivo/rede corporativa
// nunca recebe o vídeo (a conexão parece estabelecida, mas nenhum frame chega,
// o que aparece pro usuário como "imagem toda preta"). Um servidor TURN de
// fallback resolve isso retransmitindo a mídia quando a conexão direta falha.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};
const QUALITY_PRESETS = {
  economy:  { width: 1280, height: 720,  frameRate: 15, maxBitrate: 1_200_000 },
  balanced: { width: 1600, height: 900,  frameRate: 24, maxBitrate: 2_200_000 },
  high:     { width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_500_000 }
};
let localStream = null;
let isSharing = false;
const peers = new Map(); // viewerId -> RTCPeerConnection
let knownParticipantIds = new Set();
let hostPeerConnection = null;
let currentHostId = null;
const resyncAttempts = new Map(); // viewerId -> nº de reconexões já tentadas (host)
let statsWatchInterval = null;
let statsWatchBytes = -1;
let statsWatchFrames = -1;
let statsWatchResyncSent = false;

// Preenche a sala automaticamente se veio na URL (?sala=xxx)
const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get('sala');
if (roomFromUrl) roomInput.value = roomFromUrl;

// ============================================================
// Controle geral de qual área de vídeo está visível
// ============================================================
function updateVideoVisibility() {
  const ytActive = !!currentVideoId;
  const screenActive = !!remoteVideo.srcObject;

  ytContainer.classList.toggle('hidden', !ytActive);
  remoteVideo.classList.toggle('hidden', !screenActive);
  ytQualitySelect.classList.toggle('hidden', !ytActive);
  waitingMsg.classList.toggle('hidden', ytActive || screenActive);

  if (!screenActive) unlockAudioBtn.classList.add('hidden');
}

// ============================================================
// MODO YOUTUBE
// ============================================================
function onYouTubeIframeAPIReady() {
  ytApiReady = true;
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function extractYouTubeId(input) {
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

function createYtPlayer(videoId, initialState) {
  currentVideoId = videoId;
  const state = initialState || { currentTime: 0, isPlaying: true };
  updateVideoVisibility();

  if (player) {
    playerReady = true;
    applyingRemoteState = true;
    player.loadVideoById(videoId);
    if (state.currentTime > 0.5) player.seekTo(state.currentTime, true);
    if (state.isPlaying) player.playVideo();
    else player.pauseVideo();
    lastKnownState = { isPlaying: !!state.isPlaying, currentTime: state.currentTime || 0 };
    setTimeout(() => { applyingRemoteState = false; }, 600);
    return;
  }

  playerReady = false;
  pendingInitialState = state;

  player = new YT.Player('player', {
    videoId: videoId,
    playerVars: {
      rel: 0,
      modestbranding: 1,
      fs: 0,
      controls: isHost ? 1 : 0,
      disablekb: isHost ? 0 : 1
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange
    }
  });

  playerBlock.classList.toggle('hidden', isHost);
}

function destroyYtPlayer() {
  loadGeneration++; // invalida qualquer carregamento pendente em andamento
  if (player && typeof player.destroy === 'function') player.destroy();
  player = null;
  playerReady = false;
  currentVideoId = null;
  pendingInitialState = null;
  updateVideoVisibility();
}

function onPlayerReady() {
  playerReady = true;
  if (pendingInitialState) {
    applyingRemoteState = true;
    if (pendingInitialState.currentTime > 0.5) {
      player.seekTo(pendingInitialState.currentTime, true);
    }
    if (pendingInitialState.isPlaying) player.playVideo();
    else player.pauseVideo();
    lastKnownState = {
      isPlaying: !!pendingInitialState.isPlaying,
      currentTime: pendingInitialState.currentTime || 0
    };
    pendingInitialState = null;
    setTimeout(() => { applyingRemoteState = false; }, 600);
  }
  applyYtQualityChoice();
}

function onPlayerStateChange(event) {
  if (applyingRemoteState) return;

  if (!isHost) {
    if (event.data === YT.PlayerState.PLAYING && !lastKnownState.isPlaying) {
      applyingRemoteState = true;
      player.pauseVideo();
      setTimeout(() => { applyingRemoteState = false; }, 300);
    } else if (event.data === YT.PlayerState.PAUSED && lastKnownState.isPlaying) {
      applyingRemoteState = true;
      player.playVideo();
      setTimeout(() => { applyingRemoteState = false; }, 300);
    }
    return;
  }

  if (event.data === YT.PlayerState.PLAYING) {
    lastKnownState = { isPlaying: true, currentTime: player.getCurrentTime() };
    socket.emit('playback', lastKnownState);
  } else if (event.data === YT.PlayerState.PAUSED) {
    lastKnownState = { isPlaying: false, currentTime: player.getCurrentTime() };
    socket.emit('playback', lastKnownState);
  }
}

function startTimeSyncLoop() {
  stopTimeSyncLoop();
  timeSyncInterval = setInterval(() => {
    if (isHost && player && playerReady && typeof player.getCurrentTime === 'function') {
      socket.emit('time-sync', { currentTime: player.getCurrentTime() });
    }
  }, 4000);
}
function stopTimeSyncLoop() {
  if (timeSyncInterval) clearInterval(timeSyncInterval);
  timeSyncInterval = null;
}

let loadGeneration = 0; // protege contra corrida entre eventos que chegam quase juntos

function loadYtWhenApiReady(videoId, initialState) {
  // Se esse mesmo vídeo já está carregado ou em processo de carregamento
  // (ex: os eventos 'joined' e 'room-state' chegando quase juntos), ignora a duplicata.
  if (currentVideoId === videoId && (player !== null || pendingInitialState !== null)) {
    return;
  }
  currentVideoId = videoId; // reserva já (evita disparo duplicado), mas NÃO mexe na
  // visibilidade ainda — isso só acontece quando o player for de fato criado, dentro
  // de createYtPlayer(). Do contrário, a área fica preta enquanto a API do YouTube
  // ainda está carregando, em vez de mostrar o aviso de "aguardando".

  const myGeneration = ++loadGeneration;
  const doCreate = () => {
    if (myGeneration !== loadGeneration) return; // um pedido mais novo já assumiu
    createYtPlayer(videoId, initialState);
  };

  if (ytApiReady) {
    doCreate();
  } else {
    const check = setInterval(() => {
      if (ytApiReady) { clearInterval(check); doCreate(); }
    }, 200);
  }
}

function applyYtQualityChoice() {
  if (!player || typeof player.setPlaybackQuality !== 'function') return;
  const chosen = ytQualitySelect.value;
  if (chosen && chosen !== 'default') player.setPlaybackQuality(chosen);
}

loadVideoBtn.addEventListener('click', () => {
  const id = extractYouTubeId(videoUrlInput.value);
  if (!id) {
    alert('Não consegui reconhecer esse link do YouTube. Cole a URL completa do vídeo.');
    return;
  }
  socket.emit('set-video', { videoId: id });
});

ytQualitySelect.addEventListener('change', applyYtQualityChoice);

// ============================================================
// MODO COMPARTILHAR TELA — HOST
// ============================================================
shareBtn.addEventListener('click', async () => {
  const preset = QUALITY_PRESETS[screenQualitySelect.value] || QUALITY_PRESETS.balanced;
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
        // Sem isso, em monitores 4K/ultrawide o navegador costuma ignorar o
        // "ideal" e capturar na resolução nativa da tela. Isso manda um vídeo
        // grande demais pra decodificar em aparelhos mais fracos (celular,
        // notebook antigo), que ficam com a imagem preta mesmo a conexão
        // funcionando — enquanto quem tem hardware melhor não percebe nada.
        resizeMode: 'crop-and-scale'
      },
      audio: true
    });
  } catch (err) {
    return; // usuário cancelou a seleção de tela
  }

  isSharing = true;
  shareBtn.classList.add('hidden');
  stopShareBtn.classList.remove('hidden');
  screenQualitySelect.disabled = true;

  // Preview local do que está sendo transmitido (não é ida-e-volta pela rede).
  remoteVideo.srcObject = localStream;
  remoteVideo.muted = true;
  remoteVideo.play().catch(() => {});
  updateVideoVisibility();

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
  resyncAttempts.clear();

  if (remoteVideo.srcObject) {
    remoteVideo.srcObject = null;
    remoteVideo.muted = false;
  }
  updateVideoVisibility();

  shareBtn.classList.remove('hidden');
  stopShareBtn.classList.add('hidden');
  screenQualitySelect.disabled = false;

  socket.emit('sharing-stopped');
}

function createOfferFor(viewerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(viewerId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  applyBitrateLimit(pc);
  preferVp8(pc);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('webrtc-ice', { targetId: viewerId, candidate: e.candidate });
  };

  // Se a conexão direta falhar (NAT/firewall do espectador), o vídeo fica preso
  // numa "imagem preta" pra sempre, já que o <video> recebeu a track mas nunca
  // chegam frames. Recria a conexão do zero pra tentar de novo (ex: via TURN).
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      resyncAttempts.delete(viewerId);
    } else if (pc.iceConnectionState === 'failed') {
      reconnectViewer(viewerId, pc);
    }
  };

  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => {
      socket.emit('webrtc-offer', { targetId: viewerId, sdp: pc.localDescription });
    });
}

// Recria do zero a conexão com um espectador específico (ICE falhou, ou ele
// avisou que não está recebendo frames). Limita as tentativas pra não ficar
// reconectando pra sempre caso a rede dele realmente não consiga se conectar.
const MAX_RECONNECT_ATTEMPTS = 4;
function reconnectViewer(viewerId, pc) {
  if (!isSharing || !knownParticipantIds.has(viewerId)) return;
  if (peers.get(viewerId) !== pc) return; // já foi substituída por outra tentativa

  const attempts = (resyncAttempts.get(viewerId) || 0) + 1;
  if (attempts > MAX_RECONNECT_ATTEMPTS) return;
  resyncAttempts.set(viewerId, attempts);

  pc.close();
  peers.delete(viewerId);
  createOfferFor(viewerId);
}

// Sem isso, o navegador pode escolher VP9/AV1 pra codificar (geralmente o
// preferido em compartilhamento de tela por qualidade/banda). Só que decode
// de VP9/AV1 por hardware falha em silêncio em alguns aparelhos/drivers de
// vídeo mais antigos — a conexão fica "ok", mas nada é desenhado na tela
// (imagem preta), só em quem tem esse hardware específico. VP8 tem decoder
// por software garantido em praticamente todo navegador, então é bem mais
// difícil de falhar assim.
function preferVp8(pc) {
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
  const transceiver = pc.getTransceivers().find((t) => t.sender && t.sender.track && t.sender.track.kind === 'video');
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;

  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps || !caps.codecs) return;

  const isVp8 = (c) => c.mimeType.toLowerCase() === 'video/vp8';
  const isRtx = (c) => c.mimeType.toLowerCase() === 'video/rtx';
  const vp8 = caps.codecs.filter(isVp8);
  const rtx = caps.codecs.filter(isRtx);
  const others = caps.codecs.filter((c) => !isVp8(c) && !isRtx(c));

  try {
    transceiver.setCodecPreferences([...vp8, ...rtx, ...others]);
  } catch (err) { /* navegador não suporta a combinação, ignora e usa o padrão */ }
}

function applyBitrateLimit(pc) {
  const preset = QUALITY_PRESETS[screenQualitySelect.value] || QUALITY_PRESETS.balanced;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings) params.encodings = [{}];
  params.encodings[0].maxBitrate = preset.maxBitrate;
  sender.setParameters(params).catch(() => {});
}

// ============================================================
// MODO COMPARTILHAR TELA — ESPECTADOR
// ============================================================
async function handleIncomingOffer(fromId, sdp) {
  if (isHost) return;
  // O servidor já barra isso, mas confere de novo aqui: nunca aceitar uma
  // oferta de vídeo que não venha do host de fato da sala.
  if (currentHostId && fromId !== currentHostId) return;

  stopStatsWatch();
  if (hostPeerConnection) {
    hostPeerConnection.close();
    hostPeerConnection = null;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  hostPeerConnection = pc;

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    // Começa mudo: autoplay com som é bloqueado por padrão em muitos navegadores
    // (varia por navegador/dispositivo, por isso só afeta alguns usuários) e,
    // se o play() com som falhar, o vídeo nunca chega a rodar — fica preto pra
    // sempre. Mudo, o autoplay sempre funciona; o som fica atrás do botão.
    remoteVideo.muted = true;
    remoteVideo.play().catch(() => {});
    unlockAudioBtn.classList.remove('hidden');
    updateVideoVisibility();
    startStatsWatch(pc);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('webrtc-ice', { targetId: fromId, candidate: e.candidate });
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { targetId: fromId, sdp: pc.localDescription });
}

// A conexão pode "dar certo" na sinalização (ontrack dispara, o botão de
// áudio aparece) e mesmo assim a tela ficar preta. Dois jeitos disso
// acontecer: (1) nenhum byte de vídeo chega de fato (problema de rede) ou
// (2) os bytes chegam normalmente mas o navegador não consegue DECODIFICAR
// os frames (problema de codec/hardware do aparelho do espectador — nesse
// caso reconectar sozinho não adianta se o codec escolhido for o mesmo de
// novo, por isso também forçamos VP8 em createOfferFor, que é o mais
// compatível). Monitorando os dois (bytesReceived e framesDecoded) a gente
// cobre ambos os casos e avisa o host pra recriar a conexão do zero.
function startStatsWatch(pc) {
  stopStatsWatch();
  statsWatchBytes = -1;
  statsWatchFrames = -1;
  statsWatchResyncSent = false;
  statsWatchInterval = setInterval(async () => {
    if (hostPeerConnection !== pc) { stopStatsWatch(); return; }
    let bytes = null;
    let frames = null;
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          bytes = report.bytesReceived;
          frames = typeof report.framesDecoded === 'number' ? report.framesDecoded : null;
        }
      });
    } catch (err) { return; }
    if (bytes === null) return;

    const bytesGrew = bytes > statsWatchBytes;
    const framesGrew = frames === null || frames > statsWatchFrames;
    statsWatchBytes = bytes;
    if (frames !== null) statsWatchFrames = frames;

    if (bytesGrew && framesGrew) {
      statsWatchResyncSent = false;
      return;
    }
    if (!statsWatchResyncSent) {
      statsWatchResyncSent = true;
      socket.emit('request-resync');
    }
  }, 5000);
}

function stopStatsWatch() {
  if (statsWatchInterval) clearInterval(statsWatchInterval);
  statsWatchInterval = null;
}

function clearRemoteVideo() {
  stopStatsWatch();
  if (hostPeerConnection) {
    hostPeerConnection.close();
    hostPeerConnection = null;
  }
  if (remoteVideo.srcObject) {
    remoteVideo.srcObject = null;
    remoteVideo.muted = false;
  }
  updateVideoVisibility();
}

unlockAudioBtn.addEventListener('click', () => {
  remoteVideo.muted = false;
  remoteVideo.play().catch(() => {});
  unlockAudioBtn.classList.add('hidden');
});

// ============================================================
// ABAS DO HOST — alterna entre os dois modos, encerrando o outro
// ============================================================
tabScreenBtn.addEventListener('click', () => {
  if (activeHostTab === 'screen') return;
  activeHostTab = 'screen';
  tabScreenBtn.classList.add('active');
  tabYoutubeBtn.classList.remove('active');
  hostScreenPanel.classList.remove('hidden');
  hostYoutubePanel.classList.add('hidden');

  if (currentVideoId) {
    socket.emit('clear-video');
    destroyYtPlayer();
  }
});

tabYoutubeBtn.addEventListener('click', () => {
  if (activeHostTab === 'youtube') return;
  activeHostTab = 'youtube';
  tabYoutubeBtn.classList.add('active');
  tabScreenBtn.classList.remove('active');
  hostYoutubePanel.classList.remove('hidden');
  hostScreenPanel.classList.add('hidden');

  if (isSharing) stopSharing();
});

// ============================================================
// Entrada na sala / eventos de socket comuns aos dois modos
// ============================================================
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

  socket.on('joined', ({ youAreHost, videoId, currentTime, isPlaying }) => {
    isHost = youAreHost;
    hostControls.classList.toggle('hidden', !isHost);
    closeRoomBtn.classList.toggle('hidden', !isHost);
    joinScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    roomNameDisplay.textContent = roomId;
    lastKnownState = { isPlaying: !!isPlaying, currentTime: currentTime || 0 };

    startTimeSyncLoop();

    if (videoId) {
      loadYtWhenApiReady(videoId, { currentTime, isPlaying });
    }
  });

  socket.on('room-state', (state) => {
    currentHostId = state.hostId;
    renderParticipants(state.participants, state.hostId);

    // --- Sincronização do modo YouTube ---
    if (state.videoId && state.videoId !== currentVideoId) {
      loadYtWhenApiReady(state.videoId, { currentTime: 0, isPlaying: true });
    } else if (!state.videoId && currentVideoId) {
      destroyYtPlayer();
    }

    // --- Gerenciamento de conexões do modo Compartilhar tela (só o host) ---
    const currentIds = new Set(state.participants.map((p) => p.id));
    if (isHost && isSharing) {
      currentIds.forEach((id) => {
        if (id !== socket.id && !peers.has(id)) createOfferFor(id);
      });
      knownParticipantIds.forEach((id) => {
        if (!currentIds.has(id) && peers.has(id)) {
          peers.get(id).close();
          peers.delete(id);
        }
      });
    }
    knownParticipantIds = currentIds;
  });

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
    try { await pc.addIceCandidate(candidate); } catch (err) { /* candidato fora de ordem, ignora */ }
  });

  socket.on('sharing-stopped', () => {
    clearRemoteVideo();
  });

  // Espectador avisou que a conexão travou (ontrack disparou mas nenhum frame
  // chega). Recria a conexão do zero pra ele — cobre casos em que o
  // iceConnectionState nunca chega a "failed" (fica preso em "disconnected"
  // ou até "connected" sem mídia fluindo de fato).
  socket.on('request-resync', ({ fromId }) => {
    if (!isHost || !isSharing) return;
    const pc = peers.get(fromId);
    if (pc) reconnectViewer(fromId, pc);
  });

  socket.on('playback-update', ({ isPlaying, currentTime }) => {
    lastKnownState = { isPlaying, currentTime };
    if (!player || !playerReady) return;
    applyingRemoteState = true;
    const drift = Math.abs(player.getCurrentTime() - currentTime);
    if (drift > 1.5) player.seekTo(currentTime, true);
    if (isPlaying) player.playVideo();
    else player.pauseVideo();
    setTimeout(() => { applyingRemoteState = false; }, 500);
  });

  socket.on('time-update', ({ currentTime }) => {
    lastKnownState.currentTime = currentTime;
    if (!player || !playerReady || applyingRemoteState) return;
    const drift = Math.abs(player.getCurrentTime() - currentTime);
    if (drift > 3) {
      applyingRemoteState = true;
      player.seekTo(currentTime, true);
      setTimeout(() => { applyingRemoteState = false; }, 500);
    }
  });

  socket.on('room-closed', () => {
    stopTimeSyncLoop();
    alert(isHost ? 'Você encerrou a sala.' : 'O host encerrou a sala.');
    window.location.href = window.location.pathname;
  });

  socket.on('kicked', () => {
    stopTimeSyncLoop();
    alert('Você foi expulso.');
    window.location.href = window.location.pathname;
  });
});

// --- Tela cheia (disponível para todos, se adapta ao modo ativo) ---
fullscreenBtn.addEventListener('click', () => {
  let target;
  if (currentVideoId && player && typeof player.getIframe === 'function') {
    target = player.getIframe();
  } else if (remoteVideo.srcObject) {
    target = remoteVideo;
  } else {
    target = document.querySelector('.player-wrap');
  }
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

closeRoomBtn.addEventListener('click', () => {
  if (!socket || !isHost) return;
  if (!confirm('Encerrar a sala? Todos os participantes serão desconectados.')) return;
  socket.emit('close-room');
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
