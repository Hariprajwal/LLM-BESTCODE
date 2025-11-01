require('dotenv').config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mysql = require('mysql2/promise');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws/llm" });

const PORT = process.env.PORT || 8000;
const MODEL_NAME = process.env.MODEL_NAME || "codellama:latest";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// Generate secure session secret - MUST MATCH PORT 3000 SERVER!
const generateSessionSecret = () => {
  return crypto.randomBytes(64).toString('hex');
};
// CRITICAL: This must be the same as your port 3000 server's session secret
const SESSION_SECRET = process.env.SESSION_SECRET || "your-shared-secret-key-here";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "smart_code_hub",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Session store - uses same MySQL database as port 3000
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

// Session middleware - MUST MATCH PORT 3000 CONFIG
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

// Coding keywords filter
const CODING_KEYWORDS = [
  'code', 'programming', 'algorithm', 'function', 'variable', 'loop', 'array',
  'string', 'object', 'class', 'method', 'python', 'javascript', 'java', 'cpp',
  'c++', 'html', 'css', 'react', 'node', 'sql', 'database', 'api', 'debug',
  'compile', 'syntax', 'error', 'exception', 'stack', 'queue', 'linked list',
  'binary tree', 'graph', 'sort', 'search', 'dynamic programming', 'recursion',
  'oop', 'functional programming', 'backend', 'frontend', 'fullstack', 'devops',
  'git', 'github', 'vscode', 'terminal', 'command line', 'server', 'client',
  'http', 'https', 'json', 'xml', 'rest', 'graphql', 'authentication',
  'authorization', 'encryption', 'hashing', 'database', 'mysql', 'mongodb',
  'postgresql', 'orm', 'middleware', 'framework', 'library', 'package',
  'dependency', 'npm', 'pip', 'docker', 'kubernetes', 'aws', 'azure',
  'deployment', 'ci/cd', 'testing', 'unit test', 'integration test',
  'leetcode', 'hackerrank', 'codeforces', 'dsa', 'data structure',
  'time complexity', 'space complexity', 'big o', 'optimization',
  'refactor', 'clean code', 'design pattern', 'architecture', 'microservices',
  'machine learning', 'ai', 'neural network', 'deep learning', 'tensorflow',
  'pytorch', 'pandas', 'numpy', 'data science', 'web development',
  'mobile development', 'desktop application', 'game development',
  'embedded systems', 'iot', 'blockchain', 'smart contract', 'web3',
  'cybersecurity', 'encryption', 'cryptography', 'authentication',
  'jwt', 'oauth', 'session', 'cookie', 'localstorage', 'redux', 'vue',
  'angular', 'svelte', 'typescript', 'rust', 'go', 'swift', 'kotlin',
  'php', 'ruby', 'perl', 'bash', 'shell', 'linux', 'windows', 'macos',
  'api', 'endpoint', 'route', 'controller', 'model', 'view', 'template',
  'component', 'hook', 'state', 'props', 'context', 'router', 'navigation',
  'ui', 'ux', 'responsive design', 'css grid', 'flexbox', 'bootstrap',
  'tailwind', 'sass', 'less', 'webpack', 'babel', 'vite', 'parcel',
  'authentication', 'login', 'signup', 'register', 'password', 'email',
  'verification', 'reset password', 'profile', 'user account', 'settings',
  'dashboard', 'admin', 'moderator', 'permissions', 'roles', 'acl',
  'logging', 'monitoring', 'analytics', 'metrics', 'performance',
  'optimization', 'caching', 'cdn', 'load balancing', 'scalability',
  'reliability', 'availability', 'fault tolerance', 'backup', 'recovery',
  'security', 'vulnerability', 'patch', 'update', 'upgrade', 'migration',
  'refactoring', 'legacy code', 'technical debt', 'documentation',
  'commenting', 'code review', 'pull request', 'merge', 'conflict',
  'branch', 'tag', 'release', 'version', 'semantic versioning',
  'agile', 'scrum', 'kanban', 'sprint', 'standup', 'retrospective',
  'project management', 'ticket', 'issue', 'bug', 'feature', 'enhancement',
  'requirement', 'specification', 'design', 'implementation', 'testing',
  'deployment', 'maintenance', 'support', 'troubleshooting', 'debugging',
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z'
];

const POLITE_FILTER_MESSAGE = "I appreciate your question! However, I'm specifically designed to help with coding and Data Structures & Algorithms (DSA) topics. Could you please ask me something related to programming, algorithms, or data structures? I'd be happy to help! 😊";

function isCodeRelated(prompt) {
  const lowerPrompt = prompt.toLowerCase();
  return CODING_KEYWORDS.some(keyword => lowerPrompt.includes(keyword));
}

app.use(express.json());
app.use(express.static('public'));

// CORS middleware - allow port 3000 (main app)
app.use((req, res, next) => {
  const allowedOrigins = [
    'http://localhost:3000', 
    'http://127.0.0.1:3000', 
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Cookie");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// Session validation - reads from same sessions table as port 3000
async function validateUserSession(cookieHeader) {
  try {
    if (!cookieHeader) {
      console.log("[AUTH] No cookie header provided");
      return null;
    }

    // Extract session cookie
    const sessionMatch = cookieHeader.match(/sessionId=([^;]+)/);
    if (!sessionMatch) {
      console.log("[AUTH] No sessionId cookie found");
      return null;
    }

    let sessionId = sessionMatch[1];
    
    // Handle signed cookies format
    if (sessionId.startsWith('s:')) {
      sessionId = sessionId.substring(2);
    }
    if (sessionId.startsWith('s%3A')) {
      sessionId = decodeURIComponent(sessionId).substring(2);
    }
    
    // Remove signature if present
    const dotIndex = sessionId.indexOf('.');
    if (dotIndex > -1) {
      sessionId = sessionId.substring(0, dotIndex);
    }

    console.log("[AUTH] Looking up session:", sessionId);

    const [rows] = await pool.execute(
      'SELECT data FROM sessions WHERE session_id = ? AND expires > NOW()',
      [sessionId]
    );

    if (rows.length === 0) {
      console.log("[AUTH] Session not found or expired");
      return null;
    }

    const sessionData = JSON.parse(rows[0].data);
    
    if (!sessionData.userId) {
      console.log("[AUTH] No userId in session data");
      return null;
    }

    const [users] = await pool.execute(
      'SELECT id, full_name, email FROM users WHERE id = ?',
      [sessionData.userId]
    );

    if (users.length === 0) {
      console.log("[AUTH] User not found in database");
      return null;
    }

    console.log("[AUTH] User authenticated:", users[0].full_name);
    return users[0];

  } catch (error) {
    console.error("[AUTH ERROR]", error.message);
    return null;
  }
}

// Session check endpoint - for frontend to verify
app.get("/api/session-check", async (req, res) => {
  try {
    if (req.session && req.session.userId) {
      const [user] = await pool.execute(
        'SELECT id, full_name, email FROM users WHERE id = ?',
        [req.session.userId]
      );
      
      if (user.length > 0) {
        return res.json({ 
          authenticated: true, 
          user: user[0] 
        });
      }
    }
    
    res.json({ authenticated: false });
  } catch (error) {
    console.error("[SESSION CHECK ERROR]", error);
    res.json({ authenticated: false });
  }
});

// Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", model: MODEL_NAME });
});

app.get("/test-ollama", async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    const data = await response.json();
    res.json({ status: "ok", models: data.models.map(m => m.name) });
  } catch (e) {
    res.json({ status: "error", error: e.message });
  }
});

// Serve LLM HTML page
app.get("/llm", (req, res) => {
  res.sendFile(__dirname + '/public/llm.html');
});

// WebSocket with OPTIONAL session handling - LLM works regardless of login
wss.on("connection", async (ws, req) => {
  const id = Math.random().toString(36).substr(2, 9);
  console.log(`\n[${id}] NEW CONNECTION from ${req.socket.remoteAddress}`);

  // Store current request controller for cancellation
  let currentController = null;

  // Try to validate session, but don't block if no session
  let user = null;
  try {
    user = await validateUserSession(req.headers.cookie);
    if (user) {
      console.log(`[${id}] AUTHENTICATED AS: ${user.full_name} (ID: ${user.id})`);
      
      // Send welcome message with user info
      ws.send(JSON.stringify({
        type: "system",
        content: `Welcome back ${user.full_name}! How can I help you with coding today?`,
        user: { name: user.full_name, id: user.id }
      }));
    } else {
      console.log(`[${id}] UNAUTHENTICATED - Running in guest mode`);
      
      // Send generic welcome for guest users
      ws.send(JSON.stringify({
        type: "system", 
        content: "Welcome to Stratify! I'm your DSA assistant. How can I help you with coding today?"
      }));
    }
  } catch (error) {
    console.log(`[${id}] Session check failed, running in guest mode:`, error.message);
    
    // Send generic welcome even if session check fails
    ws.send(JSON.stringify({
      type: "system",
      content: "Welcome to Stratify! I'm your DSA assistant. How can I help you with coding today?"
    }));
  }

  ws.on("message", async (input) => {
    const prompt = input.toString().trim();
    const userName = user ? user.full_name : "Guest";
    console.log(`[${id}] [${userName}] PROMPT: "${prompt}"`);

    // Check if prompt is code-related
    if (!isCodeRelated(prompt)) {
      console.log(`[${id}] FILTERED: Not code-related`);
      ws.send(JSON.stringify({ 
        type: "complete", 
        content: POLITE_FILTER_MESSAGE,
        filtered: true
      }));
      return;
    }

    // Cancel previous request if exists
    if (currentController) {
      currentController.abort();
      console.log(`[${id}] Cancelled previous request`);
    }

    try {
      // Create new AbortController for this request
      currentController = new AbortController();
      const signal = currentController.signal;

      // Include user name in system prompt if available, otherwise use generic
      const systemPrompt = user 
        ? `You are a helpful coding assistant. You will answer any coding and DSA (Data Structures and Algorithms) related questions. User: ${user.full_name}`
        : `You are a helpful coding assistant. You will answer any coding and DSA (Data Structures and Algorithms) related questions.`;
      
      const fullPrompt = `${systemPrompt}\n\nUser: ${prompt}`;

      const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL_NAME,
          prompt: fullPrompt,
          stream: true,
          options: {
            temperature: 0.7
          }
        }),
        signal: signal
      });

      if (!response.ok) {
        ws.send(JSON.stringify({ 
          type: "error", 
          content: `Ollama responded with status ${response.status}` 
        }));
        currentController = null;
        return;
      }

      if (!response.body) {
        ws.send(JSON.stringify({ 
          type: "error", 
          content: "No response body from Ollama" 
        }));
        currentController = null;
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullResponse = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim() === '') continue;
            
            try {
              const json = JSON.parse(line);
              if (json.response) {
                fullResponse += json.response;
                ws.send(JSON.stringify({ 
                  type: "stream", 
                  content: json.response 
                }));
              }
              if (json.done) {
                ws.send(JSON.stringify({ 
                  type: "complete", 
                  content: fullResponse 
                }));
                currentController = null;
                break;
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      } catch (readError) {
        if (readError.name === 'AbortError') {
          console.log(`[${id}] Request was cancelled`);
          // Don't send error message for cancelled requests
          return;
        }
        throw readError;
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`[${id}] Request was cancelled`);
        return;
      }
      console.error(`[${id}] ERROR:`, error.message);
      ws.send(JSON.stringify({ 
        type: "error", 
        content: error.message 
      }));
      currentController = null;
    }
  });

  ws.on("close", () => {
    // Cancel any ongoing request when connection closes
    if (currentController) {
      currentController.abort();
    }
    const userName = user ? user.full_name : "Guest";
    console.log(`[${id}] CLOSED - User: ${userName}`);
  });

  ws.on("error", (e) => {
    console.error(`[${id}] ERROR:`, e.message);
  });
});

server.listen(PORT, () => {
  console.log(`\n🤖 LLM Server running on port ${PORT}`);
  console.log(`📚 Model: ${MODEL_NAME}`);
  console.log(`🔗 Ollama: ${OLLAMA_URL}`);
  console.log(`🔐 Session sharing: ENABLED (optional)`);
  console.log(`🌐 Access at: http://localhost:${PORT}/llm`);
  console.log(`⚡ Health check: http://localhost:${PORT}/health`);
  console.log(`💡 Note: LLM works for both authenticated and guest users\n`);
});
