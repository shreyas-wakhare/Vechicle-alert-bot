/**
 * config/settings.js  v4
 */

const IMAP_PRESETS = {
  gmail:   { host: 'imap.gmail.com',        port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993 },
  yahoo:   { host: 'imap.mail.yahoo.com',   port: 993 },
};

const provider = (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase();
const preset   = IMAP_PRESETS[provider] || {};

module.exports = {
  email: {
    user:          process.env.EMAIL_USER,
    password:      process.env.EMAIL_PASSWORD,
    alertSender:   process.env.ALERT_SENDER,           // primary system (system1)
    alertSender2:  process.env.ALERT_SENDER_2 || 'noreply@track9999.com',  // track9999
    host:          process.env.IMAP_HOST || preset.host,
    port:          parseInt(process.env.IMAP_PORT || preset.port || 993),
    keepaliveInterval: 5 * 60 * 1000,
    pollInterval:  parseInt(process.env.EMAIL_POLL_INTERVAL || 30) * 1000,
    reconnect:     { initialDelay: 5_000, maxDelay: 5 * 60_000, multiplier: 2 },
  },

  whatsapp: {
    groupName:   process.env.WHATSAPP_GROUP_NAME,
    sessionPath: './.wwebjs_auth',
  },

  alerts: {
    ignored:     (process.env.IGNORED_ALERTS || '')
                   .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    minSeverity: process.env.MIN_SEVERITY || 'LOW',
  },

  health: {
    reportInterval: 60_000,
  },

  // Admin who can control the bot via personal WhatsApp messages
  adminNumber: process.env.ADMIN_NUMBER || '971527456266',

  // Numbers to DM for 3+ red severity (comma-separated in .env)
  criticalContacts: (process.env.CRITICAL_CONTACTS || '971565227135,971564002750')
                      .split(',').map(s => s.trim()).filter(Boolean),

  // Fleet alert batching interval in minutes (default: 30)
  alertReportIntervalMinutes: parseInt(process.env.ALERT_REPORT_INTERVAL_MINUTES || '30', 10),
};
