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

// WebSocket endpoint
wss.on("connection", (socket) => {
  console.log("User connected");

  socket.on("message", async (userInput) => {
    try {
      // Send initial message
      socket.send("Hi, I'm Smart Code Hub... 🤖\n");

      // Use the fetch API to call Ollama's API directly
      const response = await fetch('http://localhost:11434/api/generate', {
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
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
