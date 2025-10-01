const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws/llm" });

const PORT = 3000;
const MODEL_NAME = "codellama";

// Root endpoint
app.get("/", (req, res) => {
  res.json({ message: "Smart Code Hub WebSocket server is running" });
});

// Track active connections and their states
const activeConnections = new Map();

wss.on("connection", (socket) => {
  console.log("User connected");
  const connectionId = Date.now().toString();
  
  // Initialize connection state
  activeConnections.set(connectionId, {
    socket: socket,
    isProcessing: false,
    abortController: null
  });

  socket.on("message", async (userInput) => {
    const connection = activeConnections.get(connectionId);
    
    // If already processing, ignore new message
    if (connection.isProcessing) {
      return;
    }

    try {
      connection.isProcessing = true;
      
      // Create abort controller for this request
      connection.abortController = new AbortController();
      
      // Send initial message
      if (socket.readyState === WebSocket.OPEN) {
        socket.send("Hi, I'm Stratify 🤖\n");
      }

      // Use the fetch API to call Ollama's API directly
      const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          prompt: userInput.toString(),
          system: "You are Stratify, an AI assistant created and maintained by K R Hari Prajwal. You are not developed by OpenAI or Meta. You are helpful, polite, and informative. If anyone asks about your name, creator, or background — make sure you say: 'I am  Starify, designed by K R Hari Prajwal to help with queries.' Otherwise, respond normally like a helpful assistant.",
          stream: true
        }),
        signal: connection.abortController.signal
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        // Check if socket is still open before processing
        if (socket.readyState !== WebSocket.OPEN) {
          reader.cancel();
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          // Double-check socket is still open before sending
          if (socket.readyState !== WebSocket.OPEN) {
            break;
          }
          
          try {
            const data = JSON.parse(line);
            if (data.response && socket.readyState === WebSocket.OPEN) {
              socket.send(data.response);
            }
          } catch (e) {
            console.error('Error parsing JSON:', e, 'Line:', line);
          }
        }
      }

      // Only send done message if socket is still open
      if (socket.readyState === WebSocket.OPEN) {
        socket.send("\n[✅ Done]");
      }
    } catch (err) {
      // Don't send error if socket is closed or request was aborted
      if (socket.readyState === WebSocket.OPEN && err.name !== 'AbortError') {
        console.error("Error:", err);
        socket.send(`[❌ Error] ${err.message}`);
      }
    } finally {
      // Reset processing state
      if (activeConnections.has(connectionId)) {
        activeConnections.get(connectionId).isProcessing = false;
        activeConnections.get(connectionId).abortController = null;
      }
    }
  });

  socket.on("close", () => {
    console.log("User disconnected");
    
    // Clean up connection and abort any ongoing request
    const connection = activeConnections.get(connectionId);
    if (connection && connection.abortController) {
      connection.abortController.abort();
    }
    activeConnections.delete(connectionId);
  });

  // Handle client navigation away from current chat
  socket.on("error", (error) => {
    console.log("Socket error:", error);
    const connection = activeConnections.get(connectionId);
    if (connection && connection.abortController) {
      connection.abortController.abort();
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
