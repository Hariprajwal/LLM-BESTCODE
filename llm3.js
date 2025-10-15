require('dotenv').config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mysql = require('mysql2/promise');
const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server, 
  path: "/ws/llm",
  verifyClient: (info, done) => {
    console.log("🔐 WebSocket connection attempt from:", info.origin);
    done(true); // Accept ALL connections, we'll authenticate inside
  }
});

const PORT = process.env.LLM_PORT || 8000;
const MODEL_NAME = process.env.MODEL_NAME || "codellama";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "smart_code_hub",
  port: parseInt(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Simple CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Cookie");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

app.use(express.json());
app.use(cookieParser());

// Track active connections
const activeConnections = new Map();

// ==================== SESSION VALIDATION (UNCHANGED - WORKING) ====================
async function validateUserSession(cookieHeader) {
  try {
    if (!cookieHeader) {
      console.log("❌ No cookies provided");
      return null;
    }

    console.log("🍪 Raw cookies:", cookieHeader);

    // Extract sessionId using simpler method
    const sessionMatch = cookieHeader.match(/sessionId=([^;]+)/);
    if (!sessionMatch) {
      console.log("❌ No sessionId in cookies");
      return null;
    }

    let sessionId = sessionMatch[1];
    console.log("🎯 Extracted sessionId:", sessionId);

    // Clean session ID
    if (sessionId.startsWith('s:')) {
      sessionId = sessionId.substring(2);
    }
    if (sessionId.startsWith('s%3A')) {
      sessionId = decodeURIComponent(sessionId).substring(2);
    }
    
    // Remove signature
    const dotIndex = sessionId.indexOf('.');
    if (dotIndex > -1) {
      sessionId = sessionId.substring(0, dotIndex);
    }

    console.log("🔧 Cleaned sessionId:", sessionId);

    // DIRECT DATABASE QUERY - NO EXPIRY CHECK FOR DEBUGGING
    const [rows] = await pool.execute(
      'SELECT data FROM sessions WHERE session_id = ?',
      [sessionId]
    );

    if (rows.length === 0) {
      console.log("❌ Session not found in database");
      
      // Debug: Show all sessions
      try {
        const [allSessions] = await pool.execute('SELECT session_id, expires FROM sessions LIMIT 5');
        console.log("📋 Available sessions:", allSessions);
      } catch (e) {
        console.log("❌ Could not fetch sessions:", e.message);
      }
      
      return null;
    }

    console.log("✅ Session found in database");

    // Parse session data
    let sessionData;
    try {
      sessionData = JSON.parse(rows[0].data);
      console.log("📋 Session data:", JSON.stringify(sessionData, null, 2));
    } catch (parseError) {
      console.log("❌ Failed to parse session data:", parseError.message);
      return null;
    }

    if (!sessionData.userId) {
      console.log("❌ No userId in session");
      return null;
    }

    // Get user info
    const [users] = await pool.execute(
      'SELECT id, full_name, email, avatar_url FROM users WHERE id = ?',
      [sessionData.userId]
    );

    if (users.length === 0) {
      console.log("❌ User not found for ID:", sessionData.userId);
      return null;
    }

    const user = users[0];
    console.log("✅ User authenticated:", user.full_name);
    return user;

  } catch (error) {
    console.error("🔴 Session validation error:", error);
    return null;
  }
}

// Safe send helper
function safeSend(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(data);
      return true;
    } catch (err) {
      console.error("Send error:", err.message);
      return false;
    }
  }
  return false;
}

// ==================== API ROUTES ====================

// Root endpoint
app.get("/", (req, res) => {
  res.json({ 
    message: "Smart Starify LLM Server - READY",
    status: "running", 
    port: PORT,
    model: MODEL_NAME
  });
});

// Health check
app.get("/health", async (req, res) => {
  let ollamaStatus = false;
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    ollamaStatus = response.ok;
  } catch (err) {
    ollamaStatus = false;
  }
  
  res.json({
    status: "healthy",
    ollama: ollamaStatus,
    connections: activeConnections.size,
    uptime: process.uptime()
  });
});

// Debug endpoint to check session
app.get("/debug-session", async (req, res) => {
  const cookies = req.headers.cookie;
  const user = await validateUserSession(cookies);
  
  res.json({
    cookies: cookies,
    authenticated: !!user,
    user: user
  });
});

// Enhanced debug endpoint
app.get("/debug-session-detailed", async (req, res) => {
  const cookies = req.headers.cookie;
  
  console.log("=== SESSION DEBUG ===");
  console.log("Cookies:", cookies);
  
  if (!cookies) {
    return res.json({ error: "No cookies" });
  }

  // Parse all cookies
  const cookieObj = {};
  cookies.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookieObj[key] = value;
  });

  console.log("Parsed cookies:", cookieObj);

  const sessionId = cookieObj.sessionId;
  console.log("Session ID:", sessionId);

  if (!sessionId) {
    return res.json({ error: "No sessionId in cookies" });
  }

  try {
    // Check sessions table
    const [sessions] = await pool.execute('SELECT * FROM sessions LIMIT 5');
    console.log("All sessions:", sessions);

    // Check specific session
    let cleanSessionId = sessionId;
    if (cleanSessionId.startsWith('s:')) cleanSessionId = cleanSessionId.substring(2);
    if (cleanSessionId.startsWith('s%3A')) cleanSessionId = decodeURIComponent(cleanSessionId).substring(2);
    
    const dotIndex = cleanSessionId.indexOf('.');
    if (dotIndex > -1) cleanSessionId = cleanSessionId.substring(0, dotIndex);

    console.log("Looking for session:", cleanSessionId);

    const [matchedSessions] = await pool.execute(
      'SELECT * FROM sessions WHERE session_id = ?',
      [cleanSessionId]
    );

    res.json({
      cookies: cookieObj,
      sessionId: sessionId,
      cleanSessionId: cleanSessionId,
      sessionFound: matchedSessions.length > 0,
      sessionData: matchedSessions[0],
      allSessions: sessions
    });

  } catch (error) {
    res.json({ error: error.message });
  }
});

// Check database structure
app.get("/debug-db", async (req, res) => {
  try {
    const [tables] = await pool.execute('SHOW TABLES');
    const [sessions] = await pool.execute('DESCRIBE sessions');
    const [users] = await pool.execute('DESCRIBE users');
    
    res.json({
      tables,
      sessions_structure: sessions,
      users_structure: users
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Test Ollama connection directly
app.get("/test-ollama", async (req, res) => {
  try {
    console.log("🔍 Testing Ollama connection...");
    
    // Test 1: Check if Ollama is running
    const tagsResponse = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    if (!tagsResponse.ok) {
      throw new Error(`Ollama tags API returned ${tagsResponse.status}`);
    }
    
    const tagsData = await tagsResponse.json();
    console.log("📦 Available models:", tagsData.models);
    
    // Test 2: Try a simple generate request
    const testPrompt = "Hello, respond with just 'OK' and nothing else.";
    const generateResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        prompt: testPrompt,
        stream: false
      }),
      timeout: 10000
    });
    
    let generateData;
    if (generateResponse.ok) {
      generateData = await generateResponse.json();
    }
    
    res.json({
      ollama_status: "connected",
      ollama_url: OLLAMA_URL,
      model: MODEL_NAME,
      available_models: tagsData.models,
      test_response: generateData,
      error: null
    });
    
  } catch (error) {
    console.error("❌ Ollama test failed:", error.message);
    res.json({
      ollama_status: "disconnected",
      ollama_url: OLLAMA_URL,
      model: MODEL_NAME,
      available_models: [],
      test_response: null,
      error: error.message
    });
  }
});

// Test streaming endpoint
app.post("/test-stream", async (req, res) => {
  try {
    const { prompt } = req.body;
    
    console.log("🔍 Testing streaming with prompt:", prompt);
    
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        prompt: prompt || "Say 'Stream test successful' in one sentence.",
        stream: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`Ollama API returned ${response.status}`);
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.response) {
            res.write(data.response);
          }
          if (data.done) {
            res.write("\n\n✅ Stream complete\n");
          }
        } catch (e) {
          // Skip parse errors
        }
      }
    }
    
    res.end();
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FIXED WEB SOCKET HANDLER ====================

wss.on("connection", async (ws, req) => {
  const connectionId = Date.now().toString();
  console.log(`\n📡 NEW WebSocket Connection: ${connectionId}`);
  console.log(`📍 From: ${req.headers.origin}`);
  console.log(`🍪 Cookies: ${req.headers.cookie ? 'Present' : 'Missing'}`);
  
  let user = null;
  let authenticated = false;

  // STEP 1: Try authentication with detailed logging
  try {
    console.log("🔐 Starting authentication...");
    user = await validateUserSession(req.headers.cookie);
    authenticated = !!user;
    
    if (authenticated) {
      console.log(`✅ AUTHENTICATED: ${user.full_name} (ID: ${user.id})`);
      safeSend(ws, `Hi ${user.full_name}! I'm Smart Starify 🤖\nHow can I help you code today?\n\n`);
    } else {
      console.log("❌ AUTHENTICATION FAILED - No valid session");
      safeSend(ws, "🔐 Please login to Smart Code Hub first, then try connecting again.\n");
      ws.close(1008, "Authentication required");
      return;
    }
  } catch (authError) {
    console.error("🔴 AUTH ERROR:", authError.message);
    safeSend(ws, "⚠️ Authentication service temporarily unavailable. Please try again.\n");
    ws.close(1011, "Authentication error");
    return;
  }

  // STEP 2: Initialize connection
  activeConnections.set(connectionId, {
    socket: ws,
    isProcessing: false,
    abortController: null,
    user: user,
    authenticated: true
  });

  console.log(`✅ Connection ${connectionId} READY for user: ${user.full_name}`);

  // STEP 3: FIXED MESSAGE HANDLER - IMPROVED STREAMING
  ws.on("message", async (userInput) => {
    const connection = activeConnections.get(connectionId);
    
    if (!connection || !connection.authenticated) {
      safeSend(ws, "❌ Please re-authenticate.\n");
      return;
    }

    if (connection.isProcessing) {
      safeSend(ws, "⏳ Please wait for current request to complete...\n");
      return;
    }

    connection.isProcessing = true;
    let reader = null;
    let fullResponse = "";

    try {
      const prompt = userInput.toString();
      console.log(`💬 Processing message from ${user.full_name}: ${prompt.substring(0, 100)}...`);
      
      // Create abort controller with timeout
      connection.abortController = new AbortController();

      console.log(`🤖 Calling Ollama API: ${OLLAMA_URL}/api/generate`);
      console.log(`📦 Using model: ${MODEL_NAME}`);

      // Call Ollama API
      const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          prompt: prompt,
          system: `You are Smart Starify, an expert AI coding assistant helping ${user.full_name}. Provide clear, helpful, and accurate coding assistance. Be concise and focused.`,
          stream: true,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40
          }
        }),
        signal: connection.abortController.signal
      });

      console.log(`📡 Ollama response status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Ollama API error: ${response.status}`, errorText);
        throw new Error(`Ollama API error: ${response.status} - ${errorText.substring(0, 100)}`);
      }

      if (!response.body) {
        throw new Error("No response body from Ollama");
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (ws.readyState !== WebSocket.OPEN) {
          console.log("⚠️ WebSocket closed during streaming");
          break;
        }

        const { done, value } = await reader.read();
        
        if (done) {
          console.log("✅ Stream completed");
          break;
        }

        // Decode and process chunks
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim() === '') continue;

          try {
            const data = JSON.parse(line);
            
            if (data.response) {
              // Send response chunk to client
              safeSend(ws, data.response);
              fullResponse += data.response;
            }

            // Check if this is the final response
            if (data.done) {
              console.log(`✅ LLM Response complete. Total length: ${fullResponse.length} chars`);
              safeSend(ws, "\n\n---\n*Response complete* ✅\n");
              break;
            }

            // Handle errors from Ollama
            if (data.error) {
              console.error("❌ Ollama error:", data.error);
              safeSend(ws, `\n❌ Error: ${data.error}\n`);
              break;
            }

          } catch (parseError) {
            // Skip invalid JSON lines
            if (!line.includes('{') && !line.includes('}')) {
              // This might be a partial chunk, we'll ignore parse errors for now
              continue;
            }
            console.log("⚠️ Failed to parse line:", line.substring(0, 100));
          }
        }
      }

      console.log(`📊 Final response sent to ${user.full_name}: ${fullResponse.length} characters`);

    } catch (err) {
      console.error("❌ LLM Processing Error:", err.message);
      
      if (ws.readyState === WebSocket.OPEN && err.name !== 'AbortError') {
        if (err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
          safeSend(ws, "\n❌ Cannot connect to Ollama. Please ensure:\n   → Ollama is running: `ollama serve`\n   → Model is pulled: `ollama pull " + MODEL_NAME + "`\n   → Ollama URL is correct: " + OLLAMA_URL + "\n");
        } else if (err.message.includes('404')) {
          safeSend(ws, `\n❌ Model '${MODEL_NAME}' not found. Please pull it:\n   → Run: ollama pull ${MODEL_NAME}\n`);
        } else if (err.message.includes('timeout') || err.message.includes('abort')) {
          safeSend(ws, "\n⏰ Request timeout. Please try again with a shorter prompt.\n");
        } else {
          safeSend(ws, `\n❌ Error: ${err.message}\n`);
        }
      }
    } finally {
      // Cleanup
      if (reader) {
        try { 
          await reader.cancel(); 
          console.log("🧹 Reader cancelled");
        } catch (e) {
          console.log("⚠️ Reader cancel error:", e.message);
        }
      }
      
      if (activeConnections.has(connectionId)) {
        activeConnections.get(connectionId).isProcessing = false;
        activeConnections.get(connectionId).abortController = null;
      }
      
      console.log(`🔄 Connection ${connectionId} ready for next message`);
    }
  });

  // STEP 4: Handle connection close
  ws.on("close", (code, reason) => {
    console.log(`👋 Connection ${connectionId} closed: ${code} - ${reason}`);
    
    const connection = activeConnections.get(connectionId);
    if (connection && connection.abortController) {
      connection.abortController.abort();
    }
    activeConnections.delete(connectionId);
  });

  // STEP 5: Handle errors
  ws.on("error", (error) => {
    console.error(`🔥 WebSocket error ${connectionId}:`, error.message);
    const connection = activeConnections.get(connectionId);
    if (connection && connection.abortController) {
      connection.abortController.abort();
    }
  });
});

// Graceful shutdown
const shutdown = () => {
  console.log("\n🛑 Shutting down Smart Starify LLM service...");
  
  // Close all WebSocket connections
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, "Server maintenance");
    }
  });
  
  server.close(() => {
    console.log("✅ HTTP server closed");
    pool.end(() => {
      console.log("✅ Database connections closed");
      console.log("🎯 Smart Starify LLM service shutdown complete");
      process.exit(0);
    });
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 SMART STARIFY LLM SERVER STARTED`);
  console.log(`📍 HTTP: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws/llm`);
  console.log(`🤖 Model: ${MODEL_NAME}`);
  console.log(`🔐 Authentication: ENABLED`);
  console.log(`💾 Database: CONNECTED`);
  console.log(`🛡️  Status: READY FOR CONNECTIONS\n`);
  
  // Test Ollama connection
  setTimeout(async () => {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
      if (response.ok) {
        console.log("✅ Ollama: CONNECTED");
      } else {
        console.log("❌ Ollama: NOT RESPONDING - Run: ollama serve");
      }
    } catch (err) {
      console.log("❌ Ollama: NOT FOUND - Run: ollama serve");
    }
  }, 1000);
});
