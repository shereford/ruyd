import './style.css';
import { DirectConnectivity, type RoomInfo } from './connectivity';
import { GameTunnel } from './tunnel';

type Msg = { name: string; text: string };
type NextAction = 'host' | 'join';

const app = document.querySelector<HTMLDivElement>('#app')!;
let name = localStorage.getItem('ruyd-name') || '';
let room: RoomInfo | null = null;
let hosting = false;
let loading = false;
let error = '';
let peers: string[] = [];
let messages: Msg[] = [];
let chatOpen = false;
let chatError = '';
let copyState: 'idle' | 'copied' | 'failed' = 'idle';
let reconnecting: { attempt: number; attempts: number } | null = null;
let signalingDegraded = false;
let unread = 0;
let gameCopied = false;
/** A game this host is offering, or the one a host offered us. One at a time for now. */
let game: { forward: number; port: number; address?: string; error?: string } | null = null;
let nextForward = 1;

const esc = (value: string) => value.replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]!));

/**
 * Calls a command on the desktop shell. Every caller is an enhancement to a feature
 * that already works in the WebView, so a missing shell is not an error.
 */
async function shellCommand(command: string, args: Record<string, unknown>): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(command, args);
  } catch {
    // Running outside Tauri, or the command is unavailable.
  }
}

/** Raised only while the window is hidden; the shell decides. */
function alertWhenHidden(title: string, body: string): void {
  void shellCommand('notify_when_hidden', { title, body });
}

async function copyConnectionString(text: string): Promise<boolean> {
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return true;
  } catch {
    // Running outside Tauri, or the clipboard command was unavailable.
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function addPeer(peer: string) {
  if (peer && !peers.includes(peer)) peers.push(peer);
}

let tunnel: GameTunnel;

const connectivity = new DirectConnectivity({
  onTunnelData(peer, data) {
    tunnel.accept(peer, data);
  },
  async onGameShared(forward, port) {
    // The host is offering a game. Bind the address this player types into it.
    game = { forward, port };
    render();
    const address = await tunnel.open(0, forward, 0, port);
    game = address
      ? { forward, port, address }
      : { forward, port, error: `Ruyd could not open port ${port} on this PC. Another program is probably already using it.` };
    render();
  },
  onGameUnshared() {
    game = null;
    void tunnel.close(0);
    render();
  },
  onPeerJoined(peer) {
    const isNew = peer !== name && !peers.includes(peer);
    addPeer(peer);
    // A reconnect replays the whole peer list; that is not news.
    if (isNew && !reconnecting) alertWhenHidden('Ruyd', `${peer} joined your room.`);
    render();
  },
  onPeerLeft(peer) {
    peers = peers.filter((candidate) => candidate !== peer || candidate === name);
    render();
  },
  onChat(sender, text) {
    messages.push({ name: sender, text });
    if (!chatOpen) unread += 1;
    alertWhenHidden(`${sender} in your Ruyd room`, text);
    render();
  },
  onReconnecting(attempt, attempts) {
    reconnecting = { attempt, attempts };
    // The room is rebuilt from the host's welcome packet on each attempt.
    peers = [name];
    chatError = '';
    render();
  },
  onReconnected(restored) {
    reconnecting = null;
    room = restored;
    error = '';
    render();
  },
  onSignalingDegraded(degraded) {
    signalingDegraded = degraded;
    render();
  },
  onDisconnected(reason) {
    void connectivity.stop();
    error = reason;
    room = null;
    hosting = false;
    peers = [];
    messages = [];
    chatError = '';
    chatOpen = false;
    copyState = 'idle';
    reconnecting = null;
    signalingDegraded = false;
    unread = 0;
    game = null;
    void tunnel.stop();
    render();
  },
});

function shell(body: string) {
  return `<main><header><div class="brand"><svg viewBox="0 0 32 32"><path d="M8 7.5h8.8a7.2 7.2 0 0 1 0 14.4H14l5.4 5.1h-5.8L5 18.6V7.5h3Zm3 5v5.4h5.5a2.7 2.7 0 0 0 0-5.4H11Z"/></svg><span>Ruyd</span></div><span>${reconnecting ? 'Reconnecting' : room ? 'Direct' : 'Ready'}</span></header>${body}<footer><span class="shield">*</span> Ruyd v${__RUYD_VERSION__} | Direct first | No traffic relay</footer></main>`;
}

function home() {
  return shell(`<section class="hero"><div class="status-orb"><i></i></div><p class="eyebrow">READY WHEN YOU ARE</p><h1>Play together.\nLike you're in the same room.</h1><p class="sub">One friend hosts, the others connect, and Ruyd negotiates an encrypted direct path automatically.</p></section>${error ? `<p class="error-banner">${esc(error)}</p>` : ''}<section class="actions"><button class="primary" id="host" ${loading ? 'disabled' : ''}><span class="button-icon">+</span><span><b>${loading ? 'Starting host...' : 'Start hosting'}</b><small>Wait for friends—no router setup</small></span><em>&rarr;</em></button><button class="secondary" id="join" ${loading ? 'disabled' : ''}><span class="button-icon">&rarr;</span><span><b>${loading ? 'Connecting...' : 'Connect'}</b><small>Paste the host's connection string</small></span><em>&rarr;</em></button></section><section class="how"><h2>No accounts. No traffic relay.</h2><ol><li><span>1</span><p><b>Choose a display name</b><small>Only the name you enter is shared.</small></p></li><li><span>2</span><p><b>Host or connect</b><small>Ruyd handles NAT discovery automatically.</small></p></li><li><span>3</span><p><b>Chat directly</b><small>Messages do not pass through Ruyd servers.</small></p></li></ol></section>`);
}

function gameSection() {
  if (hosting) {
    if (!game) {
      return `<section class="game"><div class="section-title"><h2>Play a game together</h2></div><p class="game-hint">Start your game's server or open it to LAN first, then share the port it uses. Your friends get an address to type into the game.</p><form id="share-form" class="game-form"><input name="port" type="number" min="1" max="65535" inputmode="numeric" placeholder="Game port, e.g. 25565" required><button class="primary compact">Share</button></form></section>`;
    }
    return `<section class="game"><div class="section-title"><h2>Play a game together</h2><span>Sharing</span></div><p class="game-hint">Friends can reach your game on port ${game.port}. Leave Ruyd running while you play.</p><button class="stop" id="unshare">Stop sharing port ${game.port}</button></section>`;
  }
  if (!game) return '';
  if (game.error) {
    return `<section class="game"><div class="section-title"><h2>Play a game together</h2></div><p class="notice">${esc(game.error)}</p></section>`;
  }
  if (!game.address) {
    return `<section class="game"><div class="section-title"><h2>Play a game together</h2></div><p class="game-hint">Opening a local address for the host's game...</p></section>`;
  }
  return `<section class="game"><div class="section-title"><h2>Play a game together</h2><span>Ready</span></div><p class="game-hint">Type this into the game where it asks for a server address, then join as if it were on your own network.</p><div class="code"><strong class="game-address">${esc(game.address)}</strong><button id="copy-game">${gameCopied ? 'Copied' : 'Copy'}</button></div></section>`;
}

function notice() {
  if (reconnecting) {
    return `<p class="notice working">Connection lost. Reconnecting, attempt ${reconnecting.attempt} of ${reconnecting.attempts}. You do not need the connection string again.</p>`;
  }
  if (signalingDegraded) {
    return '<p class="notice">Ruyd cannot reach its connection service. Friends who are already connected are unaffected, but nobody new can join until it recovers.</p>';
  }
  return '';
}

function active() {
  const count = Math.max(0, peers.length - 1);
  return shell(`<section class="hero active${reconnecting ? ' reconnecting' : ''}"><div class="status-orb"><i></i></div><p class="eyebrow">${hosting ? 'HOST ONLINE | WAITING FOR DIRECT CONNECTIONS' : 'ENCRYPTED DIRECT CONNECTION'}</p><h1>${hosting ? (peers.length > 1 ? 'Friends connected' : 'Waiting for friends') : `Connected to ${esc(room!.hostName || 'host')}`}</h1><p class="sub">${esc(room!.detail)}</p></section>${notice()}<section class="room"><label>CONNECTION STRING</label><div class="code"><strong>${esc(room!.code.slice(0, 18))}...</strong><button id="copy">${copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Retry' : 'Copy'}</button></div>${copyState === 'failed' ? `<input class="code-fallback" id="code-fallback" readonly value="${esc(room!.code)}">` : ''}<p>${copyState === 'failed' ? 'Ruyd could not reach the clipboard. Select the full connection string above and copy it manually.' : `${esc(room!.endpoint)} | Only share with people you trust.`}</p></section><section class="peers"><div class="section-title"><h2>In this room</h2><span>${count} friends connected</span></div>${peers.map((peer) => {
    const isSelf = peer === name;
    const isHost = hosting ? isSelf : peer === room?.hostName;
    return `<div class="peer"><span class="avatar">${esc(peer[0] || '?')}</span><p><b>${esc(peer)}${isSelf ? ' <small>(you)</small>' : ''}</b></p><em>${isHost ? 'Host' : 'Online'}</em></div>`;
  }).join('')}${gameSection()}<button class="chat-launch" id="chat">Open encrypted test chat${unread ? ` <span class="badge">${unread}</span>` : ''}</button><button class="stop" id="stop">${hosting ? 'Stop hosting' : 'Disconnect'}</button></section>${chatOpen ? chat() : ''}`);
}

function chat() {
  return `<div class="modal"><div class="scrim" id="close"></div><section class="dialog"><button class="close" id="x">&times;</button><p class="eyebrow">ENCRYPTED DIRECT CONNECTION TEST</p><h2>Room chat</h2><div class="messages">${messages.length ? messages.map(message => `<div class="message ${message.name === name ? 'mine' : ''}"><small>${esc(message.name)}</small><p>${esc(message.text)}</p></div>`).join('') : '<div class="empty-chat">No messages yet.<br/>Say hello to test the connection.</div>'}</div>${chatError ? `<p class="chat-error">${esc(chatError)}</p>` : ''}<form id="chat-form" class="chat-form"><input name="message" maxlength="500" autocomplete="off" placeholder="Type a message..." autofocus><button class="primary compact">&uarr;</button></form></section></div>`;
}

function nameDialog(next: NextAction) {
  app.insertAdjacentHTML('beforeend', `<div class="modal" id="name-modal"><div class="scrim" id="name-cancel"></div><section class="dialog"><button class="close" id="name-x">&times;</button><p class="eyebrow">YOUR DISPLAY NAME</p><h2>What should friends call you?</h2><p>This is the only local identity information Ruyd shares. Your Windows username is never read.</p><form id="name-form"><input name="name" value="${esc(name)}" minlength="2" maxlength="24" autocomplete="nickname" placeholder="Display name" autofocus required><button class="primary compact">Continue</button></form></section></div>`);
  const close = () => document.querySelector('#name-modal')?.remove();
  document.querySelector('#name-cancel')?.addEventListener('click', close);
  document.querySelector('#name-x')?.addEventListener('click', close);
  document.querySelector('#name-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = (event.currentTarget as HTMLFormElement).elements.namedItem('name') as HTMLInputElement;
    const chosen = input.value.trim();
    if (Array.from(chosen).length < 2 || Array.from(chosen).length > 24) {
      input.setCustomValidity('Enter a display name between 2 and 24 characters.');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    name = chosen;
    localStorage.setItem('ruyd-name', name);
    close();
    if (next === 'host') void startHost();
    else joinDialog();
  });
}

async function startHost() {
  loading = true;
  error = '';
  render();
  try {
    room = await connectivity.host(name);
    hosting = true;
    peers = [name];
    copyState = 'idle';
    reconnecting = null;
    signalingDegraded = false;
    unread = 0;
    game = null;
    tunnel.start();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading = false;
    render();
  }
}

function joinDialog() {
  app.insertAdjacentHTML('beforeend', `<div class="modal" id="join-modal"><div class="scrim" id="cancel"></div><section class="dialog"><button class="close" id="join-x">&times;</button><p class="eyebrow">CONNECT DIRECTLY</p><h2>Paste the host's connection string</h2><p>Ruyd will discover a direct route automatically. You do not need to forward a port.</p><form id="join-form"><input name="code" autocomplete="off" placeholder="RUYD2-..." autofocus required><button class="primary compact">Connect</button></form></section></div>`);
  const close = () => document.querySelector('#join-modal')?.remove();
  document.querySelector('#cancel')?.addEventListener('click', close);
  document.querySelector('#join-x')?.addEventListener('click', close);
  document.querySelector('#join-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const code = new FormData(event.currentTarget as HTMLFormElement).get('code')?.toString();
    if (!code) return;
    close();
    loading = true;
    error = '';
    peers = [name];
    render();
    try {
      room = await connectivity.join(code, name);
      hosting = false;
      copyState = 'idle';
      reconnecting = null;
      signalingDegraded = false;
      unread = 0;
      game = null;
      tunnel.start();
      addPeer(room.hostName || '');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      peers = [];
    } finally {
      loading = false;
      render();
    }
  });
}

function bind() {
  document.querySelector('#host')?.addEventListener('click', () => nameDialog('host'));
  document.querySelector('#join')?.addEventListener('click', () => nameDialog('join'));
  document.querySelector('#copy')?.addEventListener('click', async () => {
    copyState = (await copyConnectionString(room?.code || '')) ? 'copied' : 'failed';
    render();
    if (copyState === 'failed') {
      const fallback = document.querySelector<HTMLInputElement>('#code-fallback');
      fallback?.focus();
      fallback?.select();
    }
  });
  document.querySelector('#stop')?.addEventListener('click', async () => {
    await connectivity.stop();
    room = null;
    hosting = false;
    messages = [];
    chatError = '';
    peers = [];
    copyState = 'idle';
    reconnecting = null;
    signalingDegraded = false;
    unread = 0;
    game = null;
    void tunnel.stop();
    render();
  });
  document.querySelector('#share-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const port = Number(new FormData(form).get('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const forward = nextForward++;
    game = { forward, port };
    render();
    await tunnel.share(forward, port);
    connectivity.shareGame(forward, port);
    render();
  });
  document.querySelector('#unshare')?.addEventListener('click', async () => {
    const forward = game?.forward;
    game = null;
    render();
    if (forward !== undefined) {
      connectivity.unshareGame(forward);
      await tunnel.close(0, forward);
    }
  });
  document.querySelector('#copy-game')?.addEventListener('click', async () => {
    gameCopied = await copyConnectionString(game?.address || '');
    render();
  });
  document.querySelector('#chat')?.addEventListener('click', () => {
    chatOpen = true;
    unread = 0;
    render();
  });
  const closeChat = () => {
    chatOpen = false;
    render();
  };
  document.querySelector('#close')?.addEventListener('click', closeChat);
  document.querySelector('#x')?.addEventListener('click', closeChat);
  document.querySelector('#chat-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const text = new FormData(form).get('message')?.toString().trim();
    if (!text) return;
    const recipients = connectivity.sendChat(text);
    if (recipients === 0) {
      chatError = reconnecting
        ? 'Message was not sent. Ruyd is still reconnecting.'
        : 'Message was not sent because no direct peer connection is available.';
    } else {
      messages.push({ name, text });
      chatError = '';
      form.reset();
    }
    render();
  });
}

function trayStatus(): string {
  if (reconnecting) return 'Ruyd - reconnecting';
  if (!room) return 'Ruyd - ready';
  const suffix = unread ? ` - ${unread} unread` : '';
  if (hosting) {
    const friends = Math.max(0, peers.length - 1);
    return `Ruyd - hosting, ${friends} ${friends === 1 ? 'friend' : 'friends'} connected${suffix}`;
  }
  return `Ruyd - connected to ${room.hostName || 'host'}${suffix}`;
}

let lastTrayStatus = '';

function syncTray(): void {
  const status = trayStatus();
  if (status === lastTrayStatus) return;
  lastTrayStatus = status;
  void shellCommand('set_tray_status', { status });
}

const chatInput = () => document.querySelector<HTMLInputElement>('#chat-form input[name="message"]');

function render() {
  const previous = chatInput();
  const draft = previous && {
    text: previous.value,
    caret: previous.selectionStart ?? previous.value.length,
    focused: document.activeElement === previous,
  };
  app.innerHTML = room ? active() : home();
  bind();
  syncTray();
  if (chatOpen) {
    const box = document.querySelector('.messages');
    if (box) box.scrollTop = box.scrollHeight;
    const input = chatInput();
    if (input) {
      // `autofocus` does not fire for markup inserted after load, and replacing the
      // tree would otherwise discard an unsent draft whenever a peer event arrives.
      input.value = draft ? draft.text : '';
      if (!draft || draft.focused) {
        input.focus();
        const caret = draft ? draft.caret : 0;
        input.setSelectionRange(caret, caret);
      }
    }
  }
}

// One document-level listener: the modals are rebuilt on every render, so binding
// per-element would leak handlers.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const dialog = document.querySelector('#name-modal, #join-modal');
  if (dialog) {
    dialog.remove();
    return;
  }
  if (chatOpen) {
    chatOpen = false;
    render();
  }
});

tunnel = new GameTunnel(connectivity);

render();
