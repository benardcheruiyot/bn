const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

// In-memory subscription store (keyed by userId)
const subscriptions = new Map();
const appName = process.env.APP_NAME || 'Loan App';
const appUrl = process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
const subscriptionsFilePath = path.resolve(__dirname, '../../data/push-subscriptions.json');
let pushEnabled = false;
const schedulerStats = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastReason: 'not_started',
  lastSentCount: 0,
  lastStaleRemoved: 0,
  totalSent: 0,
  totalFailures: 0,
};

function ensureSubscriptionsStorePath() {
  const dir = path.dirname(subscriptionsFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function persistSubscriptions() {
  try {
    ensureSubscriptionsStorePath();
    const payload = JSON.stringify(Object.fromEntries(subscriptions), null, 2);
    fs.writeFileSync(subscriptionsFilePath, payload, 'utf8');
  } catch (error) {
    console.error('[Push] Failed to persist subscriptions:', error.message);
  }
}

function loadSubscriptions() {
  try {
    ensureSubscriptionsStorePath();
    if (!fs.existsSync(subscriptionsFilePath)) {
      return;
    }

    const raw = fs.readFileSync(subscriptionsFilePath, 'utf8');
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    const entries = Object.entries(parsed || {});
    for (const [userId, subscription] of entries) {
      if (subscription && subscription.endpoint) {
        subscriptions.set(String(userId), subscription);
      }
    }

    console.log(`[Push] Restored ${subscriptions.size} subscription(s) from disk.`);
  } catch (error) {
    console.error('[Push] Failed to load subscriptions:', error.message);
  }
}

function configure() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();

  if (!publicKey || !privateKey) {
    pushEnabled = false;
    console.warn('[Push] VAPID keys are missing. Push notifications are disabled.');
    return false;
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@app.example.com',
    publicKey,
    privateKey
  );

  loadSubscriptions();
  pushEnabled = true;
  return true;
}

function isEnabled() {
  return pushEnabled;
}

function saveSubscription(userId, subscription) {
  subscriptions.set(String(userId), subscription);
  persistSubscriptions();
  console.log(`[Push] Saved subscription. Total active subscriptions: ${subscriptions.size}`);
}

function removeSubscription(userId) {
  subscriptions.delete(String(userId));
  persistSubscriptions();
  console.log(`[Push] Removed subscription. Total active subscriptions: ${subscriptions.size}`);
}

function getSubscriptionCount() {
  return subscriptions.size;
}

function getSchedulerStats() {
  return { ...schedulerStats };
}

async function sendNotification(subscription, payload) {
  if (!pushEnabled) {
    return false;
  }

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    // 410 Gone = subscription expired/unsubscribed
    if (err.statusCode === 410) {
      return 'gone';
    }
    console.error('Push send error:', err.message);
    return false;
  }
}

async function sendToUser(userId, payload) {
  if (!pushEnabled) return false;

  const sub = subscriptions.get(String(userId));
  if (!sub) return 'not_subscribed';
  const result = await sendNotification(sub, payload);
  if (result === 'gone') {
    subscriptions.delete(String(userId));
    persistSubscriptions();
  }
  return result;
}

const HOURLY_MESSAGES = [
  { title: 'Loan App', body: 'Need quick cash? Apply for a loan in minutes — no paperwork needed!' },
  { title: 'Loan App 💰', body: 'Your next loan is one tap away. Fast approval, flexible repayment.' },
  { title: 'Loan Ready for You', body: 'Get up to KES 100,000 today. Apply now and receive funds instantly.' },
  { title: 'Loan App Reminder', body: 'Don\'t let money hold you back. Apply for your loan right now.' },
  { title: 'Quick Cash Available', body: 'Low processing fee, high loan amounts. Start your application today!' },
  { title: 'Loan App', body: 'Pay school fees, rent, or bills — get a loan in under 5 minutes.' },
  { title: 'Funds When You Need Them', body: 'Emergency cash? Loan App has you covered. Apply now.' },
  { title: 'Loan App 🏦', body: 'Top up your business, pay bills, or cover emergencies. Loans start at KES 5,500.' },
  { title: 'Apply for a Loan Today', body: 'Repay in 30, 60, or 90 days — terms that work for you.' },
  { title: 'Loan App', body: 'Still thinking about it? Your loan application takes less than 2 minutes.' },
  { title: 'Money in Minutes', body: 'M-Pesa directly to your phone. Fast, safe, and affordable.' },
  { title: 'Loan App Reminder', body: 'Thousands of borrowers trust Loan App. Join them — apply now.' },
  { title: 'Loan App 🔔', body: 'Morning or night — we\'re always open. Apply for your loan anytime.' },
  { title: 'Got Bills to Pay?', body: 'Cover your expenses with a Loan App loan. Quick and hassle-free.' },
  { title: 'Loan App', body: 'Your financial solution is here. Apply for a loan and get funded today.' },
  { title: 'Don\'t Wait — Apply Now', body: 'Loan applications are open 24/7. Get your cash before you need it.' },
  { title: 'Loan App 💡', body: 'Smart borrowing, flexible repayment. Apply for a loan with Loan App.' },
  { title: 'Loan App', body: 'We believe in you. Get the funds you need to move forward — apply now.' },
  { title: 'Instant Loan Offer', body: 'Qualify for up to KES 100,000. Check your eligibility and apply today.' },
  { title: 'Loan App Reminder', body: 'Turn your plans into action. A loan from Loan App can make it happen.' },
  { title: 'Loan App 🌟', body: 'No long queues, no paperwork. Just fast cash via M-Pesa.' },
  { title: 'Loan App', body: 'Your future doesn\'t have to wait. Apply for a loan and take charge today.' },
  { title: 'Need Extra Cash?', body: 'Loan App loans are affordable and fast. Apply in under 2 minutes.' },
  { title: 'Loan App', body: 'Pay less in fees, get more in funds. Apply for your loan right now.' },
];

let hourlyMessageIndex = 0;

function getNextHourlyMessage() {
  const msg = HOURLY_MESSAGES[hourlyMessageIndex % HOURLY_MESSAGES.length];
  hourlyMessageIndex++;
  return msg;
}

function createHourlyPayload() {
  const { title, body } = getNextHourlyMessage();
  return {
    title,
    body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    url: appUrl,
  };
}

async function sendHourlyToUser(userId) {
  return sendToUser(userId, createHourlyPayload());
}

async function broadcastHourlyReminder() {
  schedulerStats.lastRunAt = new Date().toISOString();
  schedulerStats.lastSentCount = 0;
  schedulerStats.lastStaleRemoved = 0;

  if (!pushEnabled) {
    schedulerStats.lastReason = 'push_disabled';
    console.warn('[Push Scheduler] Skipped hourly reminder: push is disabled.');
    return;
  }

  if (subscriptions.size === 0) {
    schedulerStats.lastReason = 'no_subscriptions';
    console.warn('[Push Scheduler] Skipped hourly reminder: no active subscriptions.');
    return;
  }

  schedulerStats.lastReason = 'sending';
  console.log(`[Push Scheduler] Sending hourly reminder to ${subscriptions.size} subscription(s).`);

  const payload = createHourlyPayload();

  const stale = [];
  let sentCount = 0;
  for (const [userId, sub] of subscriptions.entries()) {
    const result = await sendNotification(sub, payload);
    if (result === true) {
      sentCount += 1;
      continue;
    }

    if (result === 'gone') {
      stale.push(userId);
      continue;
    }

    schedulerStats.totalFailures += 1;
  }

  schedulerStats.lastSentCount = sentCount;
  schedulerStats.totalSent += sentCount;

  if (stale.length > 0) {
    stale.forEach((id) => subscriptions.delete(id));
    persistSubscriptions();
    schedulerStats.lastStaleRemoved = stale.length;
    console.warn(`[Push Scheduler] Removed ${stale.length} stale subscription(s).`);
  }

  schedulerStats.lastSuccessAt = new Date().toISOString();
  schedulerStats.lastReason = 'completed';
  console.log('[Push Scheduler] Hourly reminder cycle completed.');
}

module.exports = {
  configure,
  isEnabled,
  saveSubscription,
  removeSubscription,
  sendToUser,
  sendHourlyToUser,
  broadcastHourlyReminder,
  getSubscriptionCount,
  getSchedulerStats,
  createHourlyPayload,
};
