const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { execSync } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws/llm" });

const PORT = 3000;
const MODEL_NAME = "codellama";

// Enhanced helper function to get Windows host IP with multiple detection methods
function getWindowsHostIP() {
  try {
    // Method 1: Get Windows host IP from WSL default gateway
    const ip = execSync("ip route show | grep -i default | awk '{ print $3}'")
      .toString()
      .trim();
    
    if (ip && ip !== '') {
      console.log(`🔍 Detected Windows host IP via WSL route: ${ip}`);
      return ip;
    }
  } catch (error) {
    console.log('⚠️ WSL route detection failed, trying alternative methods...');
  }

  try {
    // Method 2: Try using hostname command for WSL2
    const hostnameIP = execSync("getent hosts host.docker.internal | awk '{ print $1 }'")
      .toString()
      .trim();
    
    if (hostnameIP && hostnameIP !== '') {
      console.log(`🔍 Detected host via host.docker.internal: ${hostnameIP}`);
      return hostnameIP;
    }
  } catch (error) {
    console.log('⚠️ host.docker.internal detection failed');
  }

  // Method 3: Fallback options
  console.log('🔍 Using fallback to localhost');
  return 'localhost';
}

// Determine Ollama URL with intelligent auto-detection
const OLLAMA_HOST = process.env.OLLAMA_HOST || getWindowsHostIP();
const OLLAMA_URL = process.env.OLLAMA_URL || `http://${OLLAMA_HOST}:11434/api/generate`;

console.log(`🎯 Final Ollama URL: ${OLLAMA_URL}`);

// Root endpoint
app.get("/", (req, res) => {
  res.json({ message: "Smart Code Hub WebSocket server is running" });
});

// Health check endpoint for Ollama connection
app.get("/health", async (req, res) => {
  try {
    const response = await fetch(OLLAMA_URL.replace('/generate', '/tags'), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (response.ok) {
      res.json({ 
        status: "healthy", 
        ollama: "connected",
        url: OLLAMA_URL 
      });
    } else {
      res.status(500).json({ 
        status: "unhealthy", 
        ollama: "connection failed",
        error: `Ollama API returned ${response.status}` 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      status: "unhealthy", 
      ollama: "connection failed",
      error: error.message,
      url: OLLAMA_URL 
    });
  }
});

// WebSocket endpoint
wss.on("connection", (socket) => {
  console.log("User connected");

  socket.on("message", async (userInput) => {
    try {
      // Send initial message
      socket.send("Hi, I'm Smart Code Hub... 🤖\n");

      // Use the fetch API to call Ollama's API
      const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          prompt: userInput.toString(),
          system: "You are Smart Code Hub, an AI assistant created and maintained by K R Hari Prajwal. You are not developed by OpenAI or Meta. You are helpful, polite, and informative. If anyone asks about your name, creator, or background — make sure you say: 'I am Smart Code Hub, designed by K R Hari Prajwal to help with queries.' Otherwise, respond normally like a helpful assistant.",
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.response) {
              socket.send(data.response);
            }
          } catch (e) {
            console.error('Error parsing JSON:', e, 'Line:', line);
          }
        }
      }

      socket.send("\n[✅ Done]");
    } catch (err) {
      console.error("Error:", err);
      socket.send(`[❌ Error] ${err.message}`);
    }
  });

  socket.on("close", () => {
    console.log("User disconnected");
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// Error handling for server
server.on("error", (error) => {
  console.error("Server error:", error);
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint available at ws://localhost:${PORT}/ws/llm`);
  console.log(`🔗 Ollama API configured at: ${OLLAMA_URL}`);
  console.log(`🏥 Health check available at: http://localhost:${PORT}/health`);
});
