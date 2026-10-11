import { spawnSync } from 'node:child_process';
const args = process.argv[2] === 'race' ? ['test', '-race', './...'] : ['test', './...'];
const result = spawnSync('go', args, { cwd: new URL('../apps/relay/', import.meta.url), stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
