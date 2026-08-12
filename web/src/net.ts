import type { Snapshot } from './types';
import { mockSnapshot } from './mock';

export type LinkState = 'connecting' | 'live' | 'mock';

/**
 * Cliente do agent. Reconecta sozinho e, enquanto o agent nao responde,
 * alimenta a cidade com dados sinteticos para o render nunca ficar vazio.
 */
export class Feed {
  private ws?: WebSocket;
  private retry = 0;
  private mockTimer?: number;
  private mockOn = false;

  constructor(
    private url: string,
    private onSnapshot: (s: Snapshot) => void,
    private onState: (s: LinkState) => void,
  ) {}

  start(): void {
    this.connect();
    // se o agent nao responder em 1.5s, entra em modo mock ate ele voltar
    window.setTimeout(() => { if (!this.ws || this.ws.readyState !== 1) this.startMock(); }, 1500);
  }

  private connect(): void {
    this.onState(this.mockOn ? 'mock' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.stopMock();
      this.onState('live');
    };
    ws.onmessage = (ev) => {
      try {
        this.onSnapshot(JSON.parse(ev.data as string) as Snapshot);
      } catch { /* frame invalido: ignora */ }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.startMock();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.retry++, 15000);
    window.setTimeout(() => this.connect(), delay);
  }

  private startMock(): void {
    if (this.mockOn) return;
    this.mockOn = true;
    this.onState('mock');
    const tick = () => this.onSnapshot(mockSnapshot());
    tick();
    this.mockTimer = window.setInterval(tick, 1000);
  }

  private stopMock(): void {
    this.mockOn = false;
    if (this.mockTimer) window.clearInterval(this.mockTimer);
    this.mockTimer = undefined;
  }
}

/** ws://host:8765 por padrao; sobrescreve com ?ws=ws://outro:8765 */
export function resolveUrl(): string {
  const q = new URLSearchParams(location.search).get('ws');
  if (q) return q;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.hostname || 'localhost';
  return `${proto}//${host}:8765`;
}
