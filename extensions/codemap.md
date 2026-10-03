# extensions/

## Responsibility
Pi-agent (harici runtime) için hbmon/bg portları — opencode plugin'i değil.

## Design
- `hbmon.ts` — pi extension: handshake/watch/wait/status sarmalayıcıları;
  motor `nabiz-core/hbmon-tools`'tan gelir.
- `bg-hbmon.ts` — `pi-background-tasks` shell-task yüzeyinin hbmon
  backend'li portu (`bg_run/status/logs/kill`, polling yok).

## Integration
- Tüketir: `nabiz-core` (motor).
- Yükleyen: pi (`pi -e ...`), opencode değil.
