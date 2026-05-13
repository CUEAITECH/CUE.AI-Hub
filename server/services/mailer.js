import net from 'node:net';
import tls from 'node:tls';

function smtpConfig() {
  return {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || ''
  };
}

export function isSmtpConfigured() {
  const config = smtpConfig();
  return Boolean(config.host && config.port && config.user && config.pass && config.from);
}

function encodeHeader(value = '') {
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

function extractEmail(value = '') {
  const match = String(value).match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function escapeAddress(value = '') {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let data = '';
    const onData = (chunk) => {
      data += chunk.toString('utf8');
      const lines = data.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve(data);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(socket, text, expected = /^[23]/) {
  if (text) socket.write(`${text}\r\n`);
  const response = await readLine(socket);
  if (!expected.test(response)) {
    throw new Error(`SMTP rejected command: ${response.trim()}`);
  }
  return response;
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const options = { host: config.host, port: config.port, servername: config.host };
    const socket = config.port === 465 ? tls.connect(options) : net.connect(options);
    socket.setTimeout(15000);
    socket.once('connect', () => resolve(socket));
    socket.once('secureConnect', () => resolve(socket));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('SMTP connection timed out'));
    });
    socket.once('error', reject);
  });
}

export async function sendMail({ to, subject, text }) {
  const config = smtpConfig();
  if (!isSmtpConfigured()) throw new Error('SMTP is not configured');
  const socket = await connect(config);
  try {
    await command(socket, '', /^220/);
    await command(socket, `EHLO ${config.host}`);
    await command(socket, 'AUTH LOGIN', /^334/);
    await command(socket, Buffer.from(config.user).toString('base64'), /^334/);
    await command(socket, Buffer.from(config.pass).toString('base64'), /^235/);
    await command(socket, `MAIL FROM:<${extractEmail(config.from)}>`);
    await command(socket, `RCPT TO:<${to}>`);
    await command(socket, 'DATA', /^354/);
    const message = [
      `From: "${escapeAddress(config.from.replace(/<.*>$/, '').trim() || 'CUE Project Hub')}" <${extractEmail(config.from)}>`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(text), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '.'
    ].join('\r\n');
    await command(socket, message);
    await command(socket, 'QUIT', /^221/);
  } finally {
    socket.destroy();
  }
}

export async function sendVerificationEmail(email, code) {
  await sendMail({
    to: email,
    subject: 'CUE Project Hub 验证码',
    text: `您的 CUE Project Hub 验证码是：${code}\n\n验证码 10 分钟内有效。如果不是您本人操作，请忽略这封邮件。`
  });
}
