require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const pushService = require('./services/pushService');

const app = express();
const PORT = process.env.PORT || 5001;
const reminderIntervalMs = Math.max(
  parseInt(process.env.PUSH_REMINDER_INTERVAL_MS || '3600000', 10) || 3600000,
  60000
);
const reminderStartupDelayMs = Math.max(
  parseInt(process.env.PUSH_REMINDER_STARTUP_DELAY_MS || '120000', 10) || 120000,
  1000
);

app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// Reusable CORS config utility
const corsConfig = require('./utils/corsConfig');

app.use(cors(corsConfig));

// Request logging
app.use(morgan('combined'));

// Body parsing middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ limit: '10kb', extended: true }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  const pushStats = pushService.getSchedulerStats ? pushService.getSchedulerStats() : {};
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    services: {
      push: {
        enabled: pushService.isEnabled(),
        subscriptions: pushService.getSubscriptionCount ? pushService.getSubscriptionCount() : 0,
        scheduler: pushStats,
      },
    },
  });
});

// Routes
app.use('/api', routes);

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for: ${process.env.ALLOWED_ORIGINS || 'http://localhost:3000'}`);

  // Configure Web Push VAPID
  const pushConfigured = pushService.configure();
  if (pushConfigured) {
    console.log('🔔 Web Push configured');
    console.log(`🔔 Push reminders every ${reminderIntervalMs}ms (startup delay ${reminderStartupDelayMs}ms)`);

    const runReminderCycle = () => {
      pushService.broadcastHourlyReminder().catch((error) => {
        console.warn('[Push Scheduler] Reminder cycle failed:', error.message);
      });
    };

    // Send an early reminder after startup, then continue hourly.
    setTimeout(() => {
      runReminderCycle();
    }, reminderStartupDelayMs);

    // Hourly push notification scheduler
    setInterval(() => {
      runReminderCycle();
    }, reminderIntervalMs);
  } else {
    console.warn('🔕 Web Push disabled');
  }
});

module.exports = server;
