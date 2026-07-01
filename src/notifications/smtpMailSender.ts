import net from 'node:net';
import tls from 'node:tls';
import { SmtpConfig } from '../config';
import { MailSender, OutgoingEmail } from './emailNotifier';

/**
 * A minimal, dependency-free SMTP client that speaks just enough of the
 * protocol (EHLO, optional AUTH LOGIN, MAIL FROM, RCPT TO, DATA) to deliver a
 * MIME multipart/alternative email. Supports direct TLS (secure=true) or a
 * plaintext connection. For production hardening you may prefer a battle-tested
 * SMTP library, but this keeps the package dependency-free.
 */

/** RFC 2047 encoded-word for non-ASCII header values (e.g. Chinese subjects). */
export function encodeHeaderWord(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

function base64Part(contentType: string, body: string, boundary: string): string {
  return [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(body, 'utf8').toString('base64')),
  ].join('\r\n');
}

/** Build an RFC 5322 multipart/alternative message (text + html). */
export function buildMimeMessage(from: string, email: OutgoingEmail): string {
  const boundary = `bnd_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const headers = [
    `From: ${from}`,
    `To: ${email.to}`,
    `Subject: ${encodeHeaderWord(email.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  return (
    headers +
    '\r\n\r\n' +
    base64Part('text/plain', email.text, boundary) +
    '\r\n' +
    base64Part('text/html', email.html, boundary) +
    `\r\n--${boundary}--\r\n`
  );
}

/** Dot-stuff a message body so lines starting with '.' are not misread. */
function dotStuff(msg: string): string {
  return msg
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? '.' + l : l))
    .join('\r\n');
}

/** Wraps a socket to issue SMTP commands and await coded responses. */
class SmtpConn {
  private buffer = '';
  private waiter?: { resolve: (r: { code: number; text: string }) => void; reject: (e: Error) => void };

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      this.buffer += d;
      this.tryResolve();
    });
    socket.on('error', (e) => this.waiter?.reject(e));
    socket.on('close', () => this.waiter?.reject(new Error('SMTP connection closed')));
    socket.setTimeout(15_000, () => {
      this.waiter?.reject(new Error('SMTP timeout'));
      socket.destroy();
    });
  }

  private tryResolve(): void {
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length; i++) {
      // A final response line is "NNN " (space after the code); "NNN-" continues.
      if (/^\d{3} /.test(lines[i])) {
        const code = Number(lines[i].slice(0, 3));
        const consumed = lines.slice(0, i + 1).join('\r\n').length + 2;
        this.buffer = this.buffer.slice(consumed);
        const w = this.waiter;
        this.waiter = undefined;
        w?.resolve({ code, text: lines.slice(0, i + 1).join('\n') });
        return;
      }
    }
  }

  read(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.tryResolve();
    });
  }

  write(s: string): void {
    this.socket.write(s);
  }

  async expect(code: number): Promise<{ code: number; text: string }> {
    const r = await this.read();
    if (r.code !== code) throw new Error(`SMTP expected ${code} but got: ${r.text}`);
    return r;
  }

  async cmd(line: string, code: number): Promise<{ code: number; text: string }> {
    this.write(line + '\r\n');
    return this.expect(code);
  }

  end(): void {
    this.socket.end();
  }
}

export class SmtpMailSender implements MailSender {
  constructor(private readonly cfg: SmtpConfig) {}

  async send(email: OutgoingEmail): Promise<void> {
    const socket = this.cfg.secure
      ? tls.connect({ host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host })
      : net.connect({ host: this.cfg.host, port: this.cfg.port });
    const conn = new SmtpConn(socket);

    try {
      await conn.expect(220);
      await conn.cmd('EHLO localhost', 250);

      if (this.cfg.user && this.cfg.pass) {
        await conn.cmd('AUTH LOGIN', 334);
        await conn.cmd(Buffer.from(this.cfg.user, 'utf8').toString('base64'), 334);
        await conn.cmd(Buffer.from(this.cfg.pass, 'utf8').toString('base64'), 235);
      }

      await conn.cmd(`MAIL FROM:<${this.cfg.from}>`, 250);
      await conn.cmd(`RCPT TO:<${email.to}>`, 250);
      await conn.cmd('DATA', 354);

      const message = dotStuff(buildMimeMessage(this.cfg.from, email));
      conn.write(message + '\r\n.\r\n');
      await conn.expect(250);

      await conn.cmd('QUIT', 221).catch(() => undefined);
    } finally {
      conn.end();
    }
  }
}
