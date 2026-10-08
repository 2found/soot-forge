// Minimal SMTP test server for the email pack fixture. Node stdlib only.
// Accepts one message per connection attempt on 127.0.0.1:2525, logs the
// raw DATA to stdout, replies 250. tls:none works because server is
// loopback-only — the runner refuses none for remote hosts.
// Usage: node serve.mjs
import { createServer } from 'node:net';

const server = createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  const send = (line) => socket.write(line + '\r\n');
  send('220 fixture ESMTP');
  let data = '';
  let inData = false;
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf('\r\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          console.log('--- MESSAGE ---\n' + data + '\n--- END ---');
          send('250 2.0.0 Ok queued-fixture');
        } else {
          data += line.replace(/^\.\./, '.') + '\r\n';
        }
        continue;
      }
      const up = line.toUpperCase();
      if (up.startsWith('EHLO') || up.startsWith('HELO')) send('250-fixture\r\n250 8BITMIME');
      else if (up.startsWith('MAIL FROM')) send('250 2.1.0 Ok');
      else if (up.startsWith('RCPT TO')) send('250 2.1.5 Ok');
      else if (up === 'DATA') { inData = true; data = ''; send('354 End with <CR><LF>.<CR><LF>'); }
      else if (up === 'QUIT') { send('221 Bye'); socket.end(); }
      else if (up === 'RSET' || up === 'NOOP') send('250 Ok');
      else send('502 not implemented');
    }
  });
});
server.listen(2525, '127.0.0.1', () => console.log('fixture smtp on 127.0.0.1:2525'));
