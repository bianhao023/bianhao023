import { test } from 'node:test';
import assert from 'node:assert/strict';
import net, { AddressInfo } from 'node:net';
import { SmtpConfig } from '../src/config';
import { SmtpMailSender, buildMimeMessage, encodeHeaderWord } from '../src/notifications/smtpMailSender';

interface FakeRecord {
  commands: string[];
  mailFrom: string;
  rcpt: string;
  data: string;
  authUser?: string;
  authPass?: string;
}

/** A minimal in-process SMTP server that records the conversation. */
function fakeSmtp(): Promise<{ port: number; record: FakeRecord; close: () => void }> {
  const record: FakeRecord = { commands: [], mailFrom: '', rcpt: '', data: '' };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let dataMode = false;
    let dataBuf = '';
    let authExpect = 0; // 0 none, 1 username, 2 password
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            record.data = dataBuf;
            sock.write('250 Queued\r\n');
          } else {
            dataBuf += line + '\r\n';
          }
          continue;
        }
        const up = line.toUpperCase();
        if (authExpect === 1) {
          record.authUser = Buffer.from(line, 'base64').toString('utf8');
          authExpect = 2;
          sock.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authExpect === 2) {
          record.authPass = Buffer.from(line, 'base64').toString('utf8');
          authExpect = 0;
          sock.write('235 2.7.0 OK\r\n');
          continue;
        }
        record.commands.push(line);
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (up === 'AUTH LOGIN') { authExpect = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (up.startsWith('MAIL FROM')) { record.mailFrom = line; sock.write('250 OK\r\n'); }
        else if (up.startsWith('RCPT TO')) { record.rcpt = line; sock.write('250 OK\r\n'); }
        else if (up === 'DATA') { dataMode = true; sock.write('354 go ahead\r\n'); }
        else if (up === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('500 unknown\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      port: (server.address() as AddressInfo).port,
      record,
      close: () => server.close(),
    }));
  });
}

test('encodeHeaderWord leaves ASCII and MIME-encodes non-ASCII', () => {
  assert.equal(encodeHeaderWord('Payment received'), 'Payment received');
  assert.match(encodeHeaderWord('支付成功'), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
});

test('buildMimeMessage produces a multipart/alternative body', () => {
  const msg = buildMimeMessage('no-reply@vpn.example', {
    to: 'u@example.com', subject: '支付成功', text: 'hello', html: '<p>hello</p>',
  });
  assert.match(msg, /From: no-reply@vpn.example/);
  assert.match(msg, /To: u@example.com/);
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  assert.match(msg, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(msg, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(msg, /Content-Type: text\/html; charset=UTF-8/);
});

test('SmtpMailSender delivers over the wire without auth', async () => {
  const srv = await fakeSmtp();
  try {
    const cfg: SmtpConfig = { host: '127.0.0.1', port: srv.port, secure: false, from: 'sender@vpn.example' };
    await new SmtpMailSender(cfg).send({
      to: 'buyer@example.com', subject: 'Receipt', text: 'thanks', html: '<b>thanks</b>',
    });
    assert.match(srv.record.mailFrom, /MAIL FROM:<sender@vpn.example>/);
    assert.match(srv.record.rcpt, /RCPT TO:<buyer@example.com>/);
    assert.match(srv.record.data, /multipart\/alternative/);
    assert.ok(srv.record.commands.includes('DATA'));
    assert.ok(srv.record.commands.includes('QUIT'));
  } finally {
    srv.close();
  }
});

test('SmtpMailSender performs AUTH LOGIN when credentials are set', async () => {
  const srv = await fakeSmtp();
  try {
    const cfg: SmtpConfig = { host: '127.0.0.1', port: srv.port, secure: false, user: 'me', pass: 'secret', from: 'sender@vpn.example' };
    await new SmtpMailSender(cfg).send({ to: 'b@example.com', subject: 'S', text: 't', html: '<i>t</i>' });
    assert.equal(srv.record.authUser, 'me');
    assert.equal(srv.record.authPass, 'secret');
  } finally {
    srv.close();
  }
});
