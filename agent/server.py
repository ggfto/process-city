"""
Servidor do Process City.

- WebSocket (default :8765) faz broadcast de um snapshot por segundo.
- Opcionalmente serve o build estatico do frontend (--static ../web/dist).

Uso:
    python server.py                       # so websocket
    python server.py --static ../web/dist  # ws + http em :8080
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import http.server
import json
import socketserver
import threading
from typing import Set

import websockets

from collector import Collector

CLIENTS: Set = set()


async def _handler(ws) -> None:
    CLIENTS.add(ws)
    print(f"[ws]    cliente conectado ({len(CLIENTS)} ativo(s))")
    try:
        await ws.wait_closed()
    finally:
        CLIENTS.discard(ws)
        print(f"[ws]    cliente saiu ({len(CLIENTS)} ativo(s))")


async def _broadcast_loop(interval: float, top_n: int, kthreads: bool) -> None:
    """
    Amostra em thread separada: com centenas de processos a coleta chega a
    segundos (Windows principalmente) e travaria o handshake dos clientes se
    rodasse no event loop. O periodo e' adaptativo -- nunca amostramos mais
    rapido do que a maquina consegue.
    """
    loop = asyncio.get_running_loop()
    collector = Collector(top_n=top_n, kthreads=kthreads)
    await asyncio.to_thread(collector.snapshot)  # descarta: arma os deltas

    while True:
        t0 = loop.time()
        try:
            snap = await asyncio.to_thread(collector.snapshot)
            payload = json.dumps(snap, separators=(",", ":"))
        except Exception as exc:  # coleta nunca deve derrubar o servidor
            print(f"[collector] erro: {exc!r}")
            await asyncio.sleep(interval)
            continue

        if CLIENTS:
            await asyncio.gather(
                *(c.send(payload) for c in list(CLIENTS)),
                return_exceptions=True,
            )
        await asyncio.sleep(max(0.05, interval - (loop.time() - t0)))


def _serve_static(directory: str, port: int) -> None:
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=directory
    )

    class Quiet(socketserver.TCPServer):
        allow_reuse_address = True

    def run() -> None:
        try:
            with Quiet(("0.0.0.0", port), handler) as httpd:
                print(f"[http]  servindo {directory} em http://0.0.0.0:{port}")
                httpd.serve_forever()
        except OSError as exc:
            # com network_mode: host e' comum a porta ja estar tomada; o
            # websocket continua de pe, entao so avisamos
            print(f"[http]  porta {port} indisponivel ({exc.strerror}) -- "
                  f"UI estatica desligada, use --http-port")

    threading.Thread(target=run, daemon=True).start()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--interval", type=float, default=1.0, help="segundos entre snapshots")
    ap.add_argument("--top", type=int, default=250, help="max de processos por snapshot")
    ap.add_argument("--kthreads", action="store_true",
                    help="inclui threads de kernel (rss 0) como blocos baixos")
    ap.add_argument("--static", metavar="DIR", help="serve o build do frontend")
    ap.add_argument("--http-port", type=int, default=8080)
    args = ap.parse_args()

    if args.static:
        _serve_static(args.static, args.http_port)

    print(f"[ws]    ws://{args.host}:{args.port}  (intervalo {args.interval}s)")
    async with websockets.serve(_handler, args.host, args.port, ping_interval=20):
        await _broadcast_loop(args.interval, args.top, args.kthreads)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
