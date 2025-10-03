require('dotenv').config();
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const axios = require('axios');
const brevo = require('@getbrevo/brevo');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static("/mnt/d/downloads/SmartCodeHub1/SmartCodeHub"));

// Helper: detect Windows host IP inside WSL
function getWindowsHostIP() {
  try {
    const route = require("child_process")
      .execSync("ip route | grep default")
      .toString();
    return route.split(" ")[2].trim();
  } catch (err) {
    console.error("⚠️ Could not detect Windows host IP, defaulting to localhost");
    return "127.0.0.1";
  }
}

// Generate secure session secret
const generateSessionSecret = () => {
  return crypto.randomBytes(64).toString('hex');
};
const SESSION_SECRET = process.env.SESSION_SECRET || generateSessionSecret();

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "smart_code_hub",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000
});

// Test MySQL connection
pool.getConnection((err, connection) => {
  if (err) {
    console.error("❌ MySQL connection failed:", err);
  } else {
    console.log("✅ MySQL connected successfully!");
    connection.release();
  }
});

// Security middleware (CSP)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://accounts.google.com",
        "https://*.google.com",
        "https://apis.google.com",
        "'unsafe-inline'"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com"
      ],
      imgSrc: [
        "'self'",
        "data:",
        "https://lh3.googleusercontent.com"
      ],
      connectSrc: [
        "'self'",
        "http://localhost:3000",
        "ws://localhost:3000",
        "wss://localhost:3000",
        "http://localhost:8000",
        "ws://localhost:8000",
        "https://accounts.google.com",
        "https://oauth2.googleapis.com"
      ]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// CORS
app.use(cors({
  origin: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://172.22.0.1:5500'],
  credentials: true
}));

// Body parser
app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10kb' }));
app.use('/uploads', express.static('uploads'));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later'
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many login attempts, please try again later'
});
app.use('/login', authLimiter);
app.use('/signup', authLimiter);

// Session store
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 86400000,
  createDatabaseTable: true,
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data'
    }
  }
}, pool);

// Session middleware
app.use(session({
  name: 'sessionId',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Helper function to execute SQL queries
async function query(sql, params = []) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    console.error('Database query error:', error);
    throw new Error('Database operation failed');
  }
}

// Sanitize user input
function sanitizeInput(input) {
  if (typeof input === 'string') {
    return input.replace(/[^a-zA-Z0-9@._-]/g, '');
  }
  return input;
}

// Authentication middleware
function authenticate(req, res, next) {
  if (req.session && req.session.userId) {
    next();
  } else {
    res.status(401).json({ message: 'Unauthorized' });
  }
}

// Email configuration
const brevoApiKey = process.env.BREVO_API_KEY;
const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, brevoApiKey);

// Contest API configuration
const CLIST_API_KEY = process.env.CLIST_API_KEY;
const CLIST_USERNAME = process.env.CLIST_USERNAME;

// Helper function to send emails
async function sendEmail(to, subject, htmlContent) {
  try {
    const sendSmtpEmail = {
      sender: {
        email: process.env.EMAIL_FROM || 'noreplysmartcodehub@gmail.com',
        name: 'Smart Code Hub'
      },
      to: [{ email: to }],
      subject: subject,
      htmlContent: htmlContent
    };
    const response = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Email sent successfully');
    return true;
  } catch (err) {
    console.error('❌ Error sending email:', err.response?.body || err.message);
    return false;
  }
}

// Update contests from CLIST API
async function updateContestsFromAPI() {
  try {
    const now = new Date().toISOString();
    const url = `https://clist.by/api/v2/contest/?username=${CLIST_USERNAME}&api_key=${CLIST_API_KEY}&start__gte=${now}&order_by=start`;
    
    const response = await axios.get(url);
    const contests = response.data.objects;

    const platformMap = {
      'codechef.com': 'CodeChef',
      'codeforces.com': 'Codeforces',
      'leetcode.com': 'LeetCode',
      'atcoder.jp': 'AtCoder',
      'codingcompetitions.withgoogle.com': 'Kick Start (Google)',
      'geeksforgeeks.org': 'Geeks for Geeks',
      'hackerearth.com': 'HackerEarth'
    };

    for (const contest of contests) {
      if (platformMap[contest.resource]) {
        const startTime = new Date(contest.start);
        const endTime = new Date(contest.end);
        const duration = Math.round(contest.duration / 60);

        await query(
          `INSERT INTO contests 
          (contest_name, start_time, end_time, duration, contest_url, platform, resource_id) 
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            contest_name = VALUES(contest_name),
            start_time = VALUES(start_time),
            end_time = VALUES(end_time),
            duration = VALUES(duration),
            contest_url = VALUES(contest_url),
            platform = VALUES(platform),
            last_updated = CURRENT_TIMESTAMP`,
          [
            contest.event,
            startTime,
            endTime,
            duration,
            contest.href,
            platformMap[contest.resource],
            contest.id
          ]
        );
      }
    }
    console.log('Contests updated successfully');
  } catch (err) {
    console.error('Error updating contests:', err.message);
  }
}

// Check and send reminders
async function checkAndSendReminders() {
  try {
    const reminders = await query(
      `SELECT r.id, r.user_id, r.contest_id, 
              c.contest_name, c.start_time, c.contest_url, c.platform,
              u.email, u.full_name
       FROM reminders r
       JOIN contests c ON r.contest_id = c.id
       JOIN users u ON r.user_id = u.id
       WHERE r.reminder_sent = FALSE
       AND r.reminder_time <= NOW()`
    );

    for (const reminder of reminders) {
      try {
        await query(
          `UPDATE reminders SET reminder_sent = TRUE WHERE id = ?`,
          [reminder.id]
        );

        const htmlContent = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2c3e50;">${reminder.contest_name}</h2>
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">
              <p><strong>🕒 Starts at:</strong> ${new Date(reminder.start_time).toLocaleString('en-US', { 
                weekday: 'short', 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}</p>
              <p><strong>🏆 Platform:</strong> ${reminder.platform}</p>
              <a href="${reminder.contest_url}" target="_blank" 
                 style="display: inline-block; background-color: #3498db; 
                        color: white; padding: 10px 20px; 
                        text-decoration: none; border-radius: 4px; 
                        margin-top: 15px;">
                Join Contest
              </a>
            </div>
            <p style="margin-top: 20px;">Happy coding!</p>
          </div>
        `;

        await sendEmail(
          reminder.email,
          `Reminder: ${reminder.contest_name} starts soon!`,
          htmlContent
        );

        console.log(`Reminder sent for ${reminder.contest_name} to ${reminder.email}`);
      } catch (err) {
        console.error(`Error processing reminder: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('Error checking reminders:', err.message);
  }
}

// Schedule contest update every 15 minutes
cron.schedule('*/15 * * * *', updateContestsFromAPI);

// Schedule reminder checks every minute
cron.schedule('* * * * *', checkAndSendReminders);

// ==================== ROUTES ====================

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'Smart Code Hub API Server',
    status: 'running',
    port: PORT,
    version: '1.0.0',
    endpoints: {
      config: '/config',
      session: '/api/session',
      login: '/login',
      signup: '/signup',
      contests: '/api/contests',
      questions: '/api/qodt-questions'
    }
  });
});

// Expose Google Client ID
app.get('/config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'Google client ID not configured on server.' });
  }
  res.json({ googleClientId: clientId });
});

// Session route
app.get('/api/session', async (req, res) => {
  try {
    if (req.session && req.session.userId) {
      const [user] = await query(
        'SELECT id, full_name, email, avatar_url FROM users WHERE id = ?',
        [req.session.userId]
       );
      if (!user) return res.json({ loggedIn: false });
      return res.json({
        loggedIn: true,
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          avatar_url: user.avatar_url
        },
        sessionId: req.sessionID
      });
    }
    return res.json({ loggedIn: false });
  } catch (err) {
    console.error('Session route error:', err);
    return res.status(500).json({ loggedIn: false });
  }
});

// Signup Route
app.post('/signup', async (req, res) => {
  const { full_name, email, password } = req.body;

  if (!full_name || !email || !password) {
    return res.status(400).json({ message: 'Full name, email, and password are required' });
  }

  try {
    const sanitizedEmail = sanitizeInput(email.toLowerCase().trim());
    const sanitizedName = sanitizeInput(full_name.trim());

    const [existing] = await query('SELECT id, google_sub FROM users WHERE email = ?', [sanitizedEmail]);
    if (existing) {
      if (existing.google_sub) {
        return res.status(409).json({ message: 'This email is registered via Google. Please login with Google.' });
      }
      return res.status(409).json({ message: 'Email already exists. Please login with your password.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)',
      [sanitizedName, sanitizedEmail, hashedPassword]
    );

    req.session.userId = result.insertId;
    req.session.save();

    return res.status(201).json({
      message: 'Signup successful',
      user: { id: result.insertId, full_name: sanitizedName, email: sanitizedEmail }
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Login Route
app.post('/api/login', (req, res, next) => {
  req.url = '/login';
  next();
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    const sanitizedEmail = sanitizeInput(email.toLowerCase().trim());
    const [user] = await query('SELECT * FROM users WHERE email = ?', [sanitizedEmail]);

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    const lastLogin = user.last_login ? new Date(user.last_login) : null;
    let newStreak = 1;

    if (lastLogin) {
      const oneDay = 1000 * 60 * 60 * 24;
      const diffDays = Math.floor((today - lastLogin) / oneDay);

      if (diffDays === 1) {
        newStreak = user.login_streak + 1;
      } else if (diffDays === 0) {
        newStreak = user.login_streak;
      } else {
        newStreak = 1;
      }
    }

    let longestStreak = user.longest_login_streak || 0;
    if (newStreak > longestStreak) {
      longestStreak = newStreak;
    }

    await query(
      'UPDATE users SET last_login = ?, login_streak = ?, longest_login_streak = ? WHERE id = ?',
      [todayDate, newStreak, longestStreak, user.id]
    );

    req.session.userId = user.id;
    req.session.save();

    return res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        login_streak: newStreak,
        longest_login_streak: longestStreak
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Logout Route
app.post('/logout', authenticate, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ message: 'Logout failed' });
    }
    res.clearCookie('sessionId');
    res.json({ message: 'Logout successful' });
  });
});

// Google Login/Signup
app.post('/google-login', async (req, res) => {
  const { credential, mode } = req.body;

  if (!credential || !mode) {
    return res.status(400).json({ success: false, message: 'Missing Google credential or mode' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    const email = payload.email?.toLowerCase();
    const email_verified = payload.email_verified;
    const full_name = payload.name || '';
    const avatar_url = payload.picture || null;
    const google_sub = payload.sub;

    if (!email || !email_verified) {
      return res.status(400).json({ success: false, message: 'Email not verified by Google' });
    }

    const sanitizedEmail = sanitizeInput(email);
    const sanitizedName = sanitizeInput(full_name.trim());
    const [user] = await query('SELECT * FROM users WHERE email = ?', [sanitizedEmail]);

    if (mode === "signup") {
      if (user) {
        if (!user.google_sub) {
          return res.status(409).json({
            success: false,
            manual: true,
            message: 'This email is registered manually. Please login with your password.'
          });
        }
        return res.status(409).json({
          success: false,
          message: 'User already registered with Google. Please login instead.'
        });
      }

      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

      const insertResult = await query(
        'INSERT INTO users (full_name, email, password, avatar_url, google_sub) VALUES (?, ?, ?, ?, ?)',
        [sanitizedName, sanitizedEmail, hashedPassword, avatar_url, google_sub]
      );

      req.session.userId = insertResult.insertId;
      req.session.save();

      return res.status(201).json({
        success: true,
        message: 'Account created via Google',
        user: {
          id: insertResult.insertId,
          full_name: sanitizedName,
          email: sanitizedEmail,
          avatar_url
        }
      });
    }

    if (mode === "login") {
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'No account found. Please signup first.'
        });
      }

      if (!user.google_sub) {
        return res.status(409).json({
          success: false,
          manual: true,
          message: 'This email is registered manually. Please login with your password.'
        });
      }

      req.session.userId = user.id;
      req.session.save();

      return res.json({
        success: true,
        message: 'Logged in via Google',
        user
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid mode provided' });

  } catch (err) {
    console.error('Google login error:', err);
    return res.status(500).json({ success: false, message: 'Google authentication failed' });
  }
});

// Password Reset Routes
app.post('/forgot-password', async (req, res) => {
  const { email, username } = req.body;
  if (!email || !username) return res.status(400).json({ message: 'Email and username are required' });

  try {
    const sanitizedEmail = sanitizeInput(email);
    const [user] = await query('SELECT * FROM users WHERE email = ? AND full_name = ?', [sanitizedEmail, sanitizeInput(username)]);

    if (!user) {
      return res.status(400).json({ message: 'Invalid username or email' });
    }

    const now = new Date();
    if (user.otp_locked_until && now < new Date(user.otp_locked_until)) {
      return res.status(429).json({ message: 'Too many attempts. Try again after 24 hours.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await query(`UPDATE users SET reset_password_token=?, reset_password_expires=?, otp_attempts=0 WHERE id=?`, [otp, expires, user.id]);

    const html = `
<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: auto; padding: 20px; background: #f8f9fa; border-radius: 10px; border: 1px solid #e0e0e0;">
  <div style="text-align: center; padding-bottom: 20px; border-bottom: 2px solid #4169e1;">
    <h1 style="color: #4169e1; margin: 0;">Smart Code Hub</h1>
    <p style="color: #555; font-size: 14px; margin: 0;">Where ideas become intelligent code</p>
  </div>
  <div style="padding: 20px; text-align: center;">
    <p style="font-size: 16px; color: #333;">Hello <strong>${user.full_name}</strong>,</p>
    <p style="font-size: 16px; color: #333;">You requested to reset your password. Use the following OTP to proceed:</p>
    <div style="display: inline-block; margin: 20px 0; padding: 15px 30px; font-size: 24px; font-weight: bold; color: white; background: #4169e1; border-radius: 8px; letter-spacing: 3px;">
      ${otp}
    </div>
    <p style="color: #555; font-size: 14px;">This OTP will expire in <strong>10 minutes</strong>.</p>
  </div>
  <div style="text-align: center; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #888;">
    <p>If you didn't request this change, please ignore this email.</p>
    <p>© ${new Date().getFullYear()} Smart Code Hub</p>
  </div>
</div>
`;

    const sent = await sendEmail(sanitizedEmail, 'Smart Code Hub: OTP Reset', html);
    if (!sent) return res.status(500).json({ message: 'Failed to send OTP email.' });

    res.json({ message: 'If account exists, OTP sent.' });
  } catch (err) {
    console.error("Forgot Password Error:", err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/verify-otp', async (req, res) => {
  const { email, username, otp } = req.body;
  if (!email || !username || !otp) return res.status(400).json({ message: 'Missing fields' });

  try {
    const [user] = await query(`SELECT * FROM users WHERE email=? AND full_name=?`, [sanitizeInput(email), sanitizeInput(username)]);
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const now = new Date();
    if (user.otp_locked_until && now < new Date(user.otp_locked_until)) {
      return res.status(429).json({ message: 'Too many attempts. Try again in 24 hours.' });
    }

    if (user.reset_password_token !== otp) {
      const attempts = user.otp_attempts + 1;
      let updates = [`otp_attempts=${attempts}`];

      if (attempts >= 5) {
        const lockedUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        updates.push(`otp_locked_until='${lockedUntil.toISOString().slice(0, 19).replace('T', ' ')}'`);
      }

      await query(`UPDATE users SET ${updates.join(', ')} WHERE id=?`, [user.id]);
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (now > new Date(user.reset_password_expires)) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    res.json({ message: 'OTP verified. Proceed to set new password.' });
  } catch (err) {
    console.error("OTP Verify Error:", err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/reset-password', async (req, res) => {
  const { email, username, otp, newPassword } = req.body;
  if (!email || !username || !otp || !newPassword) return res.status(400).json({ message: 'All fields required' });

  try {
    const [user] = await query(`SELECT * FROM users WHERE email=? AND full_name=?`, [sanitizeInput(email), sanitizeInput(username)]);
    if (!user) return res.status(400).json({ message: 'Invalid user' });

    const now = new Date();
    if (user.reset_password_token !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (now > new Date(user.reset_password_expires)) return res.status(400).json({ message: 'OTP expired' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await query(`UPDATE users SET password=?, reset_password_token=NULL, reset_password_expires=NULL, otp_attempts=0, otp_locked_until=NULL WHERE id=?`, [hashed, user.id]);

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error("Reset Password Error:", err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Contest Routes
app.get('/api/contests', authenticate, async (req, res) => {
  try {
    const contests = await query(
      `SELECT id, contest_name, start_time, end_time, duration, contest_url, platform
       FROM contests
       WHERE start_time >= NOW()
       ORDER BY start_time ASC`
    );
    res.json(contests);
  } catch (err) {
    console.error('Error fetching contests:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/reminders', authenticate, async (req, res) => {
  const userId = req.session.userId;
  const { contestId } = req.body;

  if (!contestId) {
    return res.status(400).json({ message: 'contestId is required' });
  }

  try {
    const [existing] = await query(
      `SELECT id FROM reminders 
       WHERE user_id = ? AND contest_id = ? AND reminder_sent = FALSE`,
      [userId, contestId]
    );

    if (existing) {
      return res.status(400).json({ 
        message: 'You already have an active reminder for this contest' 
      });
    }

    const [contest] = await query('SELECT start_time FROM contests WHERE id = ?', [contestId]);
    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    const contestStart = new Date(contest.start_time);
    const now = new Date();
    let reminderTime;
    
    if ((contestStart - now) <= 30 * 60 * 1000) {
      reminderTime = now;
    } else {
      reminderTime = new Date(contestStart - 30 * 60000);
    }

    await query(
      `INSERT INTO reminders (user_id, contest_id, reminder_time, reminder_sent) 
       VALUES (?, ?, ?, FALSE)`,
      [userId, contestId, reminderTime]
    );

    res.json({ message: 'Reminder set successfully' });
  } catch (err) {
    console.error('Error setting reminder:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/reminders/cancel', authenticate, async (req, res) => {
  const userId = req.session.userId;
  const { contestId } = req.body;
  
  if (!contestId) {
    return res.
    status(400).json({ message: 'Contest ID is required' });
  }

  try {
    const result = await query(
      `DELETE FROM reminders 
       WHERE user_id = ? AND contest_id = ? AND reminder_sent = FALSE`,
      [userId, contestId]
    );

    if (result.affectedRows > 0) {
      res.json({ message: 'Reminder cancelled successfully' });
    } else {
      res.status(404).json({ message: 'No active reminder found to cancel' });
    }
  } catch (err) {
    console.error('Error cancelling reminder:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/reminders', authenticate, async (req, res) => {
  const userId = req.session.userId;

  try {
    const reminders = await query(
      `SELECT r.*, c.contest_name, c.start_time, c.platform, c.contest_url 
       FROM reminders r
       JOIN contests c ON r.contest_id = c.id
       WHERE r.user_id = ? AND c.end_time > NOW()
       ORDER BY c.start_time ASC`,
      [userId]
    );

    res.json(reminders);
  } catch (err) {
    console.error('Error fetching reminders:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Question Routes
app.get('/api/qodt-questions', authenticate, async (req, res) => {
  const userId = req.session.userId;

  try {
    const rows = await query(
      `SELECT
        q.qid AS id,
        q.qname AS name,
        q.qdescription AS description,
        q.sample_input AS input,
        q.sample_output AS expectedOutput,
        q.difficulty,
        qs.bookmarked,
        qs.completed
      FROM questions q
      LEFT JOIN question_status qs
        ON q.qid = qs.question_id AND qs.user_id = ?
      ORDER BY q.qid`,
      [userId]
    );

    const data = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      input: r.input,
      expectedOutput: r.expectedOutput,
      difficulty: r.difficulty || 'easy',
      bookmarked: !!r.bookmarked,
      completed: !!r.completed
    }));

    res.json(data);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/session/question', authenticate, (req, res) => {
  const { questionId } = req.body;
  if (!questionId) return res.status(400).json({ message: 'Missing questionId' });

  req.session.selectedQuestionId = questionId;
  req.session.save(err => {
    if (err) return res.status(500).json({ message: 'Failed to save questionId' });
    res.json({ success: true, questionId });
  });
});

app.get('/api/session/question', authenticate, (req, res) => {
  res.json({ questionId: req.session.selectedQuestionId || null });
});

app.post('/api/qodt-questions/update-status', authenticate, async (req, res) => {
  const userId = req.session.userId;
  const { questionId, bookmarked, completed } = req.body;

  if (!questionId) {
    return res.status(400).json({ message: 'questionId is required' });
  }

  try {
    await query(
      `INSERT INTO question_status (user_id, question_id, bookmarked, completed)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         bookmarked = VALUES(bookmarked),
         completed = VALUES(completed)`,
      [userId, questionId, bookmarked ? 1 : 0, completed ? 1 : 0]
    );

    res.json({ message: 'Status updated successfully' });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/qodt-questions/:qid', authenticate, async (req, res) => {
  const qid = req.params.qid;
  const userId = req.session.userId;
  
  if (!qid) {
    return res.status(400).json({ message: 'Question ID is required' });
  }

  try {
    const [row] = await query(
      `SELECT
        q.qid AS id,
        q.qname AS name,
        q.qdescription AS description,
        q.sample_input AS input,
        q.sample_output AS expectedOutput,
        q.difficulty,
        qs.bookmarked,
        qs.completed
      FROM questions q
      LEFT JOIN question_status qs
        ON q.qid = qs.question_id AND qs.user_id = ?
      WHERE q.qid = ?`,
      [userId, qid]
    );

    if (!row) {
      return res.status(404).json({ message: 'Question not found' });
    }

    res.json({
      id: row.id,
      name: row.name,
      description: row.description,
      input: row.input,
      expectedOutput: row.expectedOutput,
      difficulty: row.difficulty || 'easy',
      bookmarked: !!row.bookmarked,
      completed: !!row.completed
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// User Profile Routes
app.get('/api/user/:id', authenticate, async (req, res) => {
  const userId = req.params.id;
  
  if (parseInt(userId) !== req.session.userId) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  
  try {
    const [user] = await query(
      'SELECT full_name, login_streak, longest_login_streak, avatar_url FROM users WHERE id = ?',
      [userId]
    );
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json(user);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/user/:id', authenticate, async (req, res) => {
  const userId = req.params.id;
  
  if (parseInt(userId) !== req.session.userId) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  
  const { full_name, dob, gender } = req.body;

  if (!full_name || !dob || !gender) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    await query(
      `UPDATE users SET full_name = ?, dob = ?, gender = ? WHERE id = ?`,
      [sanitizeInput(full_name), dob, gender, userId]
    );
    
    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/user/:id/change-password', authenticate, async (req, res) => {
  const userId = req.params.id;
  
  if (parseInt(userId) !== req.session.userId) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Both passwords are required' });
  }

  try {
    const [user] = await query('SELECT password FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
    
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/user/:id/profile-data', authenticate, async (req, res) => {
  const userId = req.params.id;
  
  if (parseInt(userId) !== req.session.userId) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  try {
    const [user] = await query(
      `SELECT full_name, login_streak, longest_login_streak, avatar_url
       FROM users WHERE id = ?`,
      [userId]
    );

    if (!user) return res.status(404).json({ message: 'User not found' });

    const [activity] = await query(`
      SELECT 
        COUNT(DISTINCT DATE(login_time)) AS active_days,
        SUM(TIMESTAMPDIFF(MINUTE, login_time, COALESCE(logout_time, NOW()))) AS total_minutes
      FROM user_activity
      WHERE user_id = ?
    `, [userId]);

    const avgMinutes = activity.active_days ? 
      Math.round(activity.total_minutes / activity.active_days) : 0;
    const avgTimeStr = `${Math.floor(avgMinutes / 60)}h ${avgMinutes % 60}m/day`;

    const totalQuestionsByDifficulty = await query(`
      SELECT difficulty, COUNT(*) AS total 
      FROM questions GROUP BY difficulty
    `);

    const completedByUser = await query(`
      SELECT q.difficulty, COUNT(*) AS solved
      FROM questions q
      JOIN question_status qs ON q.qid = qs.question_id
      WHERE qs.user_id = ? AND qs.completed = 1
      GROUP BY q.difficulty
    `, [userId]);

    const difficultyMap = { easy: 0, medium: 0, hard: 0 };
    totalQuestionsByDifficulty.forEach(q => difficultyMap[q.difficulty] = q.total);

    const solvedMap = { easy: 0, medium: 0, hard: 0 };
    completedByUser.forEach(q => solvedMap[q.difficulty] = q.solved);

    const totalSolved = solvedMap.easy + solvedMap.medium + solvedMap.hard;
    const totalAvailable = difficultyMap.easy + difficultyMap.medium + difficultyMap.hard;

    res.json({
      full_name: user.full_name,
      login_streak: user.login_streak,
      longest_login_streak: user.longest_login_streak,
      avg_time: avgTimeStr,
      solved: solvedMap,
      totals: difficultyMap,
      total_solved: totalSolved,
      avatar_url: user.avatar_url,
      total_questions: totalAvailable
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// File upload configuration
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    if (!['.png', '.jpg', '.jpeg'].includes(ext.toLowerCase())) {
      return cb(new Error('Only images are allowed'));
    }
    cb(null, true);
  }
});

app.post('/api/user/:id/avatar', authenticate, upload.single('avatar'), async (req, res) => {
  const userId = req.params.id;
  
  if (parseInt(userId) !== req.session.userId) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const avatarPath = `/uploads/${req.file.filename}`;
  try {
    await query(`UPDATE users SET avatar_url = ? WHERE id = ?`, [avatarPath, userId]);
    res.json({ success: true, newAvatarUrl: avatarPath });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// Start Server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 Server URL: http://localhost:${PORT}`);
  updateContestsFromAPI();
});

// Attach code runner WebSocket
const attachRunner = require('./runner/exec');
attachRunner(server, {
  authCheck: (req) => {
    return true;
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    pool.end();
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = pool;
