export interface Proc {
  pid: number;
  name: string;
  user: string;
  cpu: number;      // % (pode passar de 100 em multi-core)
  rss: number;      // bytes
  threads: number;
  status: string;
  uptime: number;   // segundos
  conns: number;
  io: number;       // bytes/s de disco
  net: number;      // bytes/s de rede
}

export interface Host {
  procs: number;
  shown: number;
  cpu: number;
  ncpu: number;
  mem_used: number;
  mem_total: number;
  net_rx: number;
  net_tx: number;
  boot: number;
  sample_ms?: number;  // custo da coleta no agent
}

export interface Snapshot {
  t: number;
  host: Host;
  procs: Proc[];
}
