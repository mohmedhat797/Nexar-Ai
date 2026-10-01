import { spawn } from 'node:child_process';
const c = spawn('/tmp/nxlab/bwrap-profile.sh', ['/tmp/nxlab/wt/task1','/tmp/nxlab/run','--','bash','-c',
  'setsid sleep 3001 & (sleep 3002 &) ; nohup sleep 3003 >/dev/null 2>&1 & sleep 3004'], { stdio: 'ignore' });
console.log('bwrap-launcher pid', c.pid);
setInterval(()=>{}, 1000);
