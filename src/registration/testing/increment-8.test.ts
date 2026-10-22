import 'dotenv/config';
import { createServer, type Server, type Socket } from 'node:net';
import { testSql, TEST_EVENT_ID, assert } from './test-helpers.js';
import { config } from '../../config.js';

const mockReg = {
  registrationId: '00000000-0000-0000-0000-000000000001',
  eventId: TEST_EVENT_ID,
  email: 'notify@example.com',
  firstName: 'Notify',
  lastName: 'User',
  phone: null,
  attributes: {},
  status: 'CONFIRMED' as const,
  paymentIntentId: 'pi_test_notify',
  grossAmountCents: 10000,
  netAmountCents: 9700,
  refundedAmountCents: 0,
  stripeRefundId: null,
  captureAttemptCount: 0,
  lastCaptureAttemptAt: null,
  confirmationEmailSentAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  confirmedAt: new Date(),
  cancelledAt: null,
};

const mockWaitlistEntry = {
  waitlistEntryId: '00000000-0000-0000-0000-000000000002',
  eventId: TEST_EVENT_ID,
  email: 'waitlist@example.com',
  firstName: 'Wait',
  lastName: 'List',
  phone: null,
  createdAt: new Date(),
};

function createSmtpSink(): { server: Server; messages: string[] } {
  const messages: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    let input = '';
    let receivingData = false;
    let dataLines: string[] = [];
    socket.write('220 localhost test SMTP sink\r\n');

    socket.on('data', (chunk: string) => {
      input += chunk;
      let lineEnd = input.indexOf('\r\n');
      while (lineEnd >= 0) {
        let line = input.slice(0, lineEnd);
        input = input.slice(lineEnd + 2);
        if (receivingData) {
          if (line === '.') {
            receivingData = false;
            messages.push(dataLines.join('\r\n'));
            dataLines = [];
            socket.write('250 message accepted\r\n');
          } else {
            if (line.startsWith('..')) line = line.slice(1);
            dataLines.push(line);
          }
        } else if (/^(EHLO|HELO)\b/i.test(line)) {
          socket.write('250-localhost\r\n250 SIZE 10000000\r\n');
        } else if (/^(MAIL FROM|RCPT TO|RSET|NOOP)\b/i.test(line)) {
          socket.write('250 OK\r\n');
        } else if (/^DATA\b/i.test(line)) {
          receivingData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT\b/i.test(line)) {
          socket.end('221 Bye\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
        lineEnd = input.indexOf('\r\n');
      }
    });
  });
  return { server, messages };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP sink did not bind to a TCP port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 8: NotificationService Tests ===\n');
  const sink = createSmtpSink();
  const port = await listen(sink.server);

  // NotificationService creates its Nodemailer transport at module load, so
  // point config at this local-only SMTP sink before importing it.
  config.smtp.host = '127.0.0.1';
  config.smtp.port = port;
  config.smtp.user = '';
  config.smtp.pass = '';
  const { NotificationService } = await import('../services/NotificationService.js');
  const messages = sink.messages;
  const svc = new NotificationService();
  try {
    await test('8-1: registration confirmation is delivered to SMTP', async () => {
      await svc.sendRegistrationConfirmation(mockReg, 'Test Event');
      assert(messages.length === 1 && messages[0].includes('notify@example.com'), 'confirmation recipient delivered');
      assert(messages[0].includes('Registration confirmed: Test Event'), 'confirmation subject delivered');
    });
    await test('8-2: waitlist acknowledgement describes manual promotion', async () => {
      await svc.sendWaitlistAcknowledgement(mockWaitlistEntry, 1, 'Test Event');
      assert(messages.length === 2 && messages[1].includes('waitlist@example.com'), 'waitlist recipient delivered');
      assert(messages[1].includes('handled manually'), 'manual waitlist policy delivered');
    });
    await test('8-3: refund confirmation is delivered to SMTP', async () => {
      await svc.sendRefundConfirmation(mockReg, 5000, 'Test Event');
      assert(messages.length === 3 && messages[2].includes('notify@example.com'), 'refund recipient delivered');
      assert(messages[2].includes('Refund processed: Test Event'), 'refund subject delivered');
    });
  } finally {
    await close(sink.server);
  }

  await testSql.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
