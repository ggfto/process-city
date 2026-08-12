"""
Coletor de processos -> snapshot JSON.

Roda em Linux (via /proc, caminho completo e rapido) e tambem em Windows/macOS.
Todos os deltas (cpu, io/s, net/s) sao calculados aqui: o frontend so recebe
numeros prontos.

Custo importa: com ~400 processos, uma passagem ingenua do psutil leva ~10s no
Windows (num_threads e status abrem um handle por processo). Por isso:
  - atributos estaticos (nome, usuario, create_time) sao cacheados por pid;
  - a passagem cara (threads/status/io) roda so nos processos que vao ser
    enviados (top_n);
  - esses campos lentos so sao renovados a cada `slow_every` amostras.
No Linux tudo isso e' barato, mas o caminho e' o mesmo.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import psutil

IS_LINUX = os.name == "posix" and os.path.exists("/proc")


@dataclass
class _Prev:
    """Amostra anterior de um processo, para calcular taxas."""

    io_read: int = 0
    io_write: int = 0
    net_rx: int = 0
    net_tx: int = 0
    ts: float = 0.0


@dataclass
class Collector:
    top_n: int = 250            # processos enviados por snapshot
    # so corta ruido de verdade: daemons pequenos (1-3 MB) sao parte legitima
    # da cidade
    min_rss: int = 512 * 1024
    # threads de kernel ([kworker], [ksoftirqd]...) tem rss 0. Num servidor
    # tipico sao ~80% dos pids: incluidas viram um tapete de blocos baixos em
    # volta das torres, excluidas deixam a cidade rala.
    kthreads: bool = False
    slow_every: int = 4         # a cada N amostras, renova threads/status

    _procs: Dict[int, psutil.Process] = field(default_factory=dict)
    _static: Dict[int, Tuple[str, str, float]] = field(default_factory=dict)
    _slow: Dict[int, Tuple[int, str]] = field(default_factory=dict)
    _prev: Dict[int, _Prev] = field(default_factory=dict)
    _prev_net: Optional[tuple] = None
    _host_netns: Optional[int] = None
    _primed: bool = False
    _tick: int = 0
    _ncpu: int = field(default_factory=lambda: psutil.cpu_count() or 1)

    def __post_init__(self) -> None:
        if IS_LINUX:
            try:
                self._host_netns = os.stat("/proc/1/ns/net").st_ino
            except OSError:
                self._host_netns = None

    # ------------------------------------------------------------------ #
    # rede por processo
    # ------------------------------------------------------------------ #
    def _netns_counters(self, pid: int) -> Optional[Tuple[int, int]]:
        """
        Bytes rx/tx do net-namespace do processo.

        Processos em netns proprio (containers Docker/LXC, pods) tem contadores
        reais e isolados em /proc/<pid>/net/dev. Quem esta no netns do host
        veria o total da maquina -- nesse caso devolvemos None e o chamador cai
        na estimativa por numero de conexoes.

        Atencao: o contador e' do NAMESPACE, nao do processo. Todos os
        processos de um mesmo container reportam o mesmo trafego (o do
        container). Medicao real por processo exigiria eBPF.
        """
        if not IS_LINUX or self._host_netns is None:
            return None
        try:
            if os.stat(f"/proc/{pid}/ns/net").st_ino == self._host_netns:
                return None
            rx = tx = 0
            with open(f"/proc/{pid}/net/dev", "rb") as fh:
                for line in fh.read().decode("utf-8", "replace").splitlines()[2:]:
                    iface, _, rest = line.partition(":")
                    if iface.strip() == "lo":
                        continue
                    cols = rest.split()
                    if len(cols) >= 9:
                        rx += int(cols[0])
                        tx += int(cols[8])
            return rx, tx
        except (OSError, ValueError, IndexError):
            return None

    def _connections_by_pid(self) -> Dict[int, int]:
        """Conexoes inet abertas por pid (proxy de atividade de rede)."""
        out: Dict[int, int] = {}
        try:
            for conn in psutil.net_connections(kind="inet"):
                if conn.pid:
                    out[conn.pid] = out.get(conn.pid, 0) + 1
        except (psutil.AccessDenied, PermissionError, RuntimeError):
            pass  # sem privilegio: seguimos com o que da pra ver
        return out

    # ------------------------------------------------------------------ #
    # runtimes/loaders cujo comm nao diz nada: o nome util esta na cmdline
    _OPAQUE = ("ld-musl", "ld-linux", "busybox")
    _RUNTIME = {"python", "python3", "node", "java", "sh", "bash", "perl",
                "ruby", "php", "php-fpm", "dotnet", "mono"}

    # flags que consomem o proximo token: sem isso o valor de `-cp` vira nome
    _FLAG_TAKES_VALUE = {"-cp", "-classpath", "--class-path", "-m", "--module",
                         "-c", "-u", "-p", "--config"}

    def _pretty_name(self, proc: psutil.Process, comm: str) -> str:
        """
        `python` e `ld-musl-x86_64.so.1` viram dezenas de predios identicos.
        Quando o comm e' generico, tenta o script/binario real da cmdline.
        """
        base = comm.split()[0] if comm else comm
        opaque = base.startswith(self._OPAQUE)
        if not (opaque or base in self._RUNTIME):
            return comm
        try:
            argv = [a for a in proc.cmdline() if a]
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            return comm
        if not argv:
            return comm

        # binario real por tras do loader dinamico
        if opaque:
            for arg in argv:
                leaf = os.path.basename(arg)
                if leaf and not leaf.startswith(self._OPAQUE) and not arg.startswith("-"):
                    return leaf
            return comm

        # posicionais, ja descartando flags e os valores que elas consomem
        positional: List[str] = []
        skip = False
        for arg in argv[1:]:
            if skip:
                skip = False
                continue
            if arg.startswith("-"):
                skip = arg in self._FLAG_TAKES_VALUE
                continue
            positional.append(arg)

        if base == "java":
            if "-jar" in argv:
                i = argv.index("-jar")
                if i + 1 < len(argv):
                    return f"java:{os.path.basename(argv[i + 1])}"
            # sem -jar o alvo e' a classe principal, sempre o ultimo posicional
            if positional:
                return f"java:{positional[-1].rsplit('.', 1)[-1]}"
            return comm

        if positional:
            return f"{base}:{os.path.basename(positional[0])}"
        return comm

    def _identity(self, proc: psutil.Process) -> Tuple[str, str, float]:
        """Nome/usuario/create_time nunca mudam enquanto o pid vive -> cache."""
        cached = self._static.get(proc.pid)
        if cached is not None:
            return cached
        # cada campo falha por conta propria: processos protegidos costumam
        # negar username() mas liberar name(), e perder o nome estraga a cidade
        def safe(fn, default):
            try:
                return fn() or default
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                return default

        comm = safe(proc.name, f"pid:{proc.pid}")
        ident = (
            self._pretty_name(proc, comm),
            safe(proc.username, "?").split("\\")[-1],
            safe(proc.create_time, time.time()),
        )
        self._static[proc.pid] = ident
        return ident

    # ------------------------------------------------------------------ #
    # snapshot
    # ------------------------------------------------------------------ #
    def snapshot(self) -> dict:
        started = time.perf_counter()
        now = time.time()
        self._tick += 1
        refresh_slow = (self._tick % self.slow_every) == 1 or not self._primed

        # ---------- passagem 1: barata (rss + cpu) para todos ----------
        cheap: List[Tuple[psutil.Process, int, float]] = []
        alive: set[int] = set()

        for proc in psutil.process_iter(["pid", "memory_info"]):
            pid = proc.info["pid"]
            alive.add(pid)

            cached = self._procs.get(pid)
            if cached is None:
                self._procs[pid] = proc
                cached = proc
                try:
                    proc.cpu_percent(None)  # arma o contador de delta
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue

            mem = proc.info["memory_info"]
            rss = mem.rss if mem else 0
            if rss < self.min_rss and not (self.kthreads and rss == 0):
                continue
            try:
                cheap.append((cached, rss, cached.cpu_percent(None)))
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue

        # limpa estado de quem morreu
        for dead in set(self._procs) - alive:
            self._procs.pop(dead, None)
            self._static.pop(dead, None)
            self._slow.pop(dead, None)
            self._prev.pop(dead, None)

        # ---------- ranking: so o topo vira predio ----------
        cheap.sort(key=lambda r: (r[2], r[1]), reverse=True)
        selected = cheap[: self.top_n]
        conns = self._connections_by_pid()

        # ---------- passagem 2: cara, so nos selecionados ----------
        procs: List[dict] = []
        for proc, rss, cpu in selected:
            pid = proc.pid
            name, user, born = self._identity(proc)
            prev = self._prev.get(pid) or _Prev(ts=now)
            dt = max(now - prev.ts, 1e-3)

            if refresh_slow or pid not in self._slow:
                try:
                    self._slow[pid] = (proc.num_threads(), proc.status())
                except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                    self._slow[pid] = self._slow.get(pid, (1, "?"))
            threads, status = self._slow[pid]

            io_r = io_w = 0
            try:
                io = proc.io_counters()
                io_r, io_w = io.read_bytes, io.write_bytes
            except (psutil.AccessDenied, AttributeError, OSError, psutil.NoSuchProcess):
                pass

            ns = self._netns_counters(pid)
            net_rx, net_tx = ns if ns else (0, 0)

            sample = {
                "pid": pid,
                "name": name,
                "user": user,
                "cpu": round(cpu, 1),
                "rss": rss,
                "threads": threads,
                "status": status,
                "uptime": int(max(0, now - born)),
                "conns": conns.get(pid, 0),
                "io": 0.0,
                "net": 0.0,
            }

            if self._primed and prev.ts:
                if io_r or io_w:
                    sample["io"] = max(0.0, ((io_r - prev.io_read) + (io_w - prev.io_write)) / dt)
                if ns:
                    sample["net"] = max(0.0, ((net_rx - prev.net_rx) + (net_tx - prev.net_tx)) / dt)

            self._prev[pid] = _Prev(io_r, io_w, net_rx, net_tx, now)
            procs.append(sample)

        # ---------- host ----------
        vm = psutil.virtual_memory()
        net = psutil.net_io_counters()
        host_rx = host_tx = 0.0
        if self._prev_net and self._primed:
            p_rx, p_tx, p_ts = self._prev_net
            d = max(now - p_ts, 1e-3)
            host_rx = max(0.0, (net.bytes_recv - p_rx) / d)
            host_tx = max(0.0, (net.bytes_sent - p_tx) / d)
        self._prev_net = (net.bytes_recv, net.bytes_sent, now)

        # sem contador por-processo (netns do host) distribuimos o trafego da
        # maquina proporcionalmente as conexoes abertas -- e' estimativa.
        unmeasured = host_rx + host_tx
        total_conns = sum(p["conns"] for p in procs) or 1
        for p in procs:
            if p["net"] == 0.0 and p["conns"]:
                p["net"] = unmeasured * (p["conns"] / total_conns)
            p["net"] = round(p["net"], 1)
            p["io"] = round(p["io"], 1)

        self._primed = True
        return {
            "t": now,
            "host": {
                "procs": len(alive),
                "shown": len(procs),
                "cpu": round(psutil.cpu_percent(None), 1),
                "ncpu": self._ncpu,
                "mem_used": vm.total - vm.available,
                "mem_total": vm.total,
                "net_rx": round(host_rx, 1),
                "net_tx": round(host_tx, 1),
                "boot": psutil.boot_time(),
                "sample_ms": round((time.perf_counter() - started) * 1000),
            },
            "procs": procs,
        }
