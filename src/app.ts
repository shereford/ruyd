import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Room = { code: string; endpoint: string; direct: boolean; detail: string; hostName: string | null };
type Msg = { name: string; text: string };
type Event = { type: 'peer_joined' | 'chat' | 'disconnected'; name?: string; text?: string; reason?: string };
type NextAction = 'host' | 'join';

const app = document.querySelector<HTMLDivElement>('#app')!;
let name = localStorage.getItem('ruyd-name') || '';
let room: Room | null = null;
let hosting = false;
let loading = false;
let error = '';
let peers: string[] = [];
let messages: Msg[] = [];
let chatOpen = false;

const esc = (value: string) => value.replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]!));

listen<Event>('ruyd-event', ({ payload }) => {
  if (payload.type === 'peer_joined' && payload.name && !peers.includes(payload.name)) peers.push(payload.name);
  if (payload.type === 'chat' && payload.name && payload.text) messages.push({ name: payload.name, text: payload.text });
  if (payload.type === 'disconnected') {
    error = payload.reason || 'Disconnected';
    room = null;
    hosting = false;
    peers = [];
  }
  render();
});

function shell(body: string) {
  return `<main><header><div class="brand"><svg viewBox="0 0 32 32"><path d="M8 7.5h8.8a7.2 7.2 0 0 1 0 14.4H14l5.4 5.1h-5.8L5 18.6V7.5h3Zm3 5v5.4h5.5a2.7 2.7 0 0 0 0-5.4H11Z"/></svg><span>Ruyd</span></div><span>${room ? 'Direct' : 'Ready'}</span></header>${body}<footer><span class="shield">*</span> Player-hosted | No public Ruyd server</footer></main>`;
}

function home() {
  return shell(`<section class="hero"><div class="status-orb"><i></i></div><p class="eyebrow">READY WHEN YOU ARE</p><h1>Play together.\nLike you're in the same room.</h1><p class="sub">The player who clicks Host becomes the room server. Everyone else connects directly.</p></section>${error ? `<p class="error-banner">${esc(error)}</p>` : ''}<section class="actions"><button class="primary" id="host" ${loading ? 'disabled' : ''}><span class="button-icon">+</span><span><b>${loading ? 'Starting host...' : 'Start hosting'}</b><small>Your PC becomes the room server</small></span><em>&rarr;</em></button><button class="secondary" id="join"><span class="button-icon">&rarr;</span><span><b>Connect</b><small>Paste the host's connection string</small></span><em>&rarr;</em></button></section><section class="how"><h2>No accounts. No hosted server.</h2><ol><li><span>1</span><p><b>Choose a display name</b><small>Only the name you enter is shared.</small></p></li><li><span>2</span><p><b>Host or connect</b><small>Ruyd links players directly.</small></p></li><li><span>3</span><p><b>Test with chat</b><small>Messages travel through the host.</small></p></li></ol></section>`);
}

function active() {
  const count = hosting ? Math.max(0, peers.length - 1) : peers.length;
  const countLabel = hosting ? 'friends connected' : 'room members';
  return shell(`<section class="hero active room-hero"><div class="status-orb"><i></i></div><p class="eyebrow">${hosting ? 'HOST ONLINE | WAITING FOR CONNECTIONS' : 'CONNECTED DIRECTLY'}</p><h1>${hosting ? (peers.length > 1 ? 'Friends connected' : 'Waiting for friends') : `Connected to ${esc(room!.hostName || 'host')}`}</h1><p class="sub">${esc(room!.detail)}</p></section><section class="room"><label>CONNECTION STRING</label><div class="code long-code"><strong>${esc(room!.code.slice(0, 18))}...</strong><button id="copy">Copy</button></div><p>${esc(room!.endpoint)} | Only share with people you trust.</p></section><section class="peers"><div class="section-title"><h2>In this room</h2><span>${count} ${countLabel}</span></div>${peers.map((peer, index) => {
    const isSelf = index === 0;
    const isHost = hosting ? isSelf : peer === room?.hostName;
    return `<div class="peer"><span class="avatar">${esc(peer[0] || '?')}</span><p><b>${esc(peer)}${isSelf ? ' <small>(you)</small>' : ''}</b></p><em>${isHost ? 'Host' : 'Online'}</em></div>`;
  }).join('')}<button class="chat-launch" id="chat">Open direct test chat</button><button class="stop" id="stop">${hosting ? 'Stop hosting' : 'Disconnect'}</button></section>${chatOpen ? chat() : ''}`);
}

function chat() {
  return `<div class="modal"><div class="scrim" id="close"></div><section class="dialog"><button class="close" id="x">&times;</button><p class="eyebrow">DIRECT CONNECTION TEST</p><h2>Room chat</h2><div class="messages">${messages.length ? messages.map(message => `<div class="message ${message.name === name ? 'mine' : ''}"><small>${esc(message.name)}</small><p>${esc(message.text)}</p></div>`).join('') : '<div class="empty-chat">No messages yet.<br/>Say hello to test the connection.</div>'}</div><form id="chat-form" class="chat-form"><input name="message" maxlength="500" autocomplete="off" placeholder="Type a message..." autofocus><button class="primary compact">&uarr;</button></form></section></div>`;
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
    room = await invoke<Room>('host_room', { name });
    hosting = true;
    peers = [name];
  } catch (caught) {
    error = String(caught);
  } finally {
    loading = false;
    render();
  }
}

function joinDialog() {
  app.insertAdjacentHTML('beforeend', `<div class="modal" id="join-modal"><div class="scrim" id="cancel"></div><section class="dialog"><button class="close" id="join-x">&times;</button><p class="eyebrow">CONNECT DIRECTLY</p><h2>Paste the host's connection string</h2><form id="join-form"><input name="code" autocomplete="off" placeholder="RUYD1-..." autofocus><button class="primary compact">Connect</button></form></section></div>`);
  const close = () => document.querySelector('#join-modal')?.remove();
  document.querySelector('#cancel')?.addEventListener('click', close);
  document.querySelector('#join-x')?.addEventListener('click', close);
  document.querySelector('#join-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const code = new FormData(event.currentTarget as HTMLFormElement).get('code')?.toString();
    if (!code) return;
    close();
    loading = true;
    render();
    try {
      room = await invoke<Room>('join_room', { code, name });
      hosting = false;
      peers = [name];
      if (room.hostName && room.hostName !== name) peers.push(room.hostName);
    } catch (caught) {
      error = String(caught);
    } finally {
      loading = false;
      render();
    }
  });
}

function bind() {
  document.querySelector('#host')?.addEventListener('click', () => nameDialog('host'));
  document.querySelector('#join')?.addEventListener('click', () => nameDialog('join'));
  document.querySelector('#copy')?.addEventListener('click', async event => {
    await navigator.clipboard.writeText(room?.code || '');
    (event.currentTarget as HTMLElement).textContent = 'Copied';
  });
  document.querySelector('#stop')?.addEventListener('click', async () => {
    await invoke('stop_room');
    room = null;
    hosting = false;
    messages = [];
    peers = [];
    render();
  });
  document.querySelector('#chat')?.addEventListener('click', () => {
    chatOpen = true;
    render();
  });
  const closeChat = () => {
    chatOpen = false;
    render();
  };
  document.querySelector('#close')?.addEventListener('click', closeChat);
  document.querySelector('#x')?.addEventListener('click', closeChat);
  document.querySelector('#chat-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const text = new FormData(form).get('message')?.toString().trim();
    if (text) {
      messages.push({ name, text });
      await invoke('send_chat', { text });
      form.reset();
      render();
    }
  });
}

function render() {
  app.innerHTML = room ? active() : home();
  bind();
  if (chatOpen) {
    const box = document.querySelector('.messages');
    if (box) box.scrollTop = box.scrollHeight;
  }
}

render();
