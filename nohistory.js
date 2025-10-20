require('dotenv').config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mysql = require('mysql2/promise');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws/llm" });

const PORT = process.env.PORT || 8000;
const MODEL_NAME = process.env.MODEL_NAME || "codellama:latest";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

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

// Keywords for coding/DSA topics
const CODING_KEYWORDS = [
  // Core Programming Concepts
  'code', 'function', 'variable', 'constant', 'parameter', 'argument', 'return',
  'loop', 'for', 'while', 'do while', 'foreach', 'iteration', 'break', 'continue',
  'conditional', 'if', 'else', 'switch', 'case', 'ternary', 'operator',
  
  // Data Structures
  'data structure', 'algorithm', 'dsa', 'array', 'list', 'string', 'tuple',
  'linked list', 'doubly linked list', 'circular linked list', 'stack', 'queue',
  'deque', 'heap', 'priority queue', 'tree', 'binary tree', 'binary search tree',
  'bst', 'avl tree', 'red black tree', 'b tree', 'trie', 'graph', 'directed graph',
  'undirected graph', 'dag', 'hash', 'hash table', 'hash map', 'dictionary',
  'set', 'matrix', 'grid','program','hey','hello','hi',
  
  // Algorithms
  'sort', 'bubble sort', 'selection sort', 'insertion sort', 'merge sort',
  'quick sort', 'heap sort', 'counting sort', 'radix sort', 'bucket sort',
  'search', 'linear search', 'binary search', 'depth first search', 'dfs',
  'breadth first search', 'bfs', 'dijkstra', 'bellman ford', 'floyd warshall',
  'kruskal', 'prim', 'topological sort', 'dynamic programming', 'dp',
  'greedy', 'backtracking', 'divide and conquer', 'recursion', 'memoization',
  'optimization', 'complexity', 'Big O', 'space complexity', 'time complexity',
  'asymptotic', 'amortized',
  
  // Programming Languages
  'python', 'javascript', 'java', 'cpp', 'c++', 'c', 'csharp', 'c#', 'rust',
  'go', 'golang', 'ruby', 'php', 'swift', 'kotlin', 'typescript', 'scala',
  'groovy', 'perl', 'r', 'matlab', 'lua', 'haskell', 'erlang', 'clojure',
  
  // Object Oriented Programming
  'class', 'object', 'instance', 'inheritance', 'polymorphism', 'encapsulation',
  'abstraction', 'interface', 'abstract', 'method', 'property', 'attribute',
  'constructor', 'destructor', 'getter', 'setter', 'static', 'final', 'access modifier',
  'public', 'private', 'protected', 'friend', 'virtual', 'override', 'super',
  
  // Functional Programming
  'functional', 'lambda', 'arrow function', 'callback', 'promise', 'async',
  'await', 'generator', 'iterator', 'map', 'filter', 'reduce', 'fold',
  'pure function', 'side effect', 'immutable', 'immutability', 'closure',
  
  // Development & Debugging
  'debug', 'breakpoint', 'debugger', 'console', 'log', 'error', 'exception',
  'try catch', 'finally', 'throw', 'stack trace', 'assertion', 'unit test',
  'integration test', 'testing', 'mock', 'stub', 'patch', 'coverage',
  
  // Syntax & Compilation
  'syntax', 'logic', 'compile', 'compiler', 'interpreter', 'bytecode',
  'ast', 'parsing', 'lexing', 'token', 'literal', 'identifier', 'keyword',
  'semicolon', 'bracket', 'brace', 'syntax error', 'runtime error',
  
  // Web Development
  'html', 'css', 'dom', 'api', 'rest', 'restful', 'http', 'https', 'json',
  'xml', 'yaml', 'fetch', 'ajax', 'websocket', 'framework', 'library',
  'react', 'vue', 'angular', 'node', 'nodejs', 'express', 'flask', 'django',
  'bootstrap', 'tailwind', 'webpack', 'babel', 'npm', 'yarn', 'pip', 'maven',
  
  // Database
  'database', 'sql', 'mysql', 'postgresql', 'mongodb', 'redis', 'nosql',
  'query', 'select', 'insert', 'update', 'delete', 'join', 'index',
  'primary key', 'foreign key', 'transaction', 'orm', 'normalization',
  
  // Version Control & Collaboration
  'git', 'github', 'gitlab', 'bitbucket', 'commit', 'push', 'pull', 'merge',
  'branch', 'fork', 'clone', 'rebase', 'stash', 'diff', 'conflict',
  
  // DevOps & Deployment
  'docker', 'kubernetes', 'container', 'ci', 'cd', 'jenkins', 'deployment',
  'production', 'staging', 'environment', 'server', 'client', 'cloud',
  'aws', 'azure', 'gcp', 'heroku', 'lambda',
  
  // Coding Platforms
  'leetcode', 'hackerrank', 'codeforces', 'codewars', 'geeksforgeeks',
  'stack overflow', 'github', 'codepen', 'replit',
  
  // Best Practices & Design
  'design pattern', 'solid', 'dry', 'kiss', 'yagni', 'refactor', 'refactoring',
  'code review', 'documentation', 'comment', 'clean code', 'best practice',
  'convention', 'style guide', 'linter', 'formatter', 'prettier', 'eslint'
];
// Polite message for non-coding queries
const POLITE_FILTER_MESSAGE = "I appreciate your question! However, I'm specifically designed to help with coding and Data Structures & Algorithms (DSA) topics. Could you please ask me something related to programming, algorithms, or data structures? I'd be happy to help! 😊";

// Check if prompt is coding/DSA related
function isCodeRelated(prompt) {
  const lowerPrompt = prompt.toLowerCase();
  return CODING_KEYWORDS.some(keyword => lowerPrompt.includes(keyword));
}

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

// Session validation
async function validateUserSession(cookieHeader) {
  try {
    if (!cookieHeader) return null;
    const sessionMatch = cookieHeader.match(/sessionId=([^;]+)/);
    if (!sessionMatch) return null;
    let sessionId = sessionMatch[1];
    if (sessionId.startsWith('s:')) sessionId = sessionId.substring(2);
    if (sessionId.startsWith('s%3A')) sessionId = decodeURIComponent(sessionId).substring(2);
    const dotIndex = sessionId.indexOf('.');
    if (dotIndex > -1) sessionId = sessionId.substring(0, dotIndex);

    const [rows] = await pool.execute('SELECT data FROM sessions WHERE session_id = ?', [sessionId]);
    if (rows.length === 0) return null;
    const sessionData = JSON.parse(rows[0].data);
    if (!sessionData.userId) return null;
    const [users] = await pool.execute('SELECT id, full_name FROM users WHERE id = ?', [sessionData.userId]);
    return users.length > 0 ? users[0] : null;
  } catch (error) {
    console.error("[AUTH ERROR]", error.message);
    return null;
  }
}

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

// WebSocket
wss.on("connection", async (ws, req) => {
  const id = Math.random().toString(36).substr(2, 9);
  console.log(`\n[${id}] NEW CONNECTION`);

  ws.on("message", async (input) => {
    const prompt = input.toString().trim();
    console.log(`[${id}] PROMPT: "${prompt}"`);

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

    try {
      const systemPrompt = `You are a helpful coding assistant. You will answer any coding and DSA (Data Structures and Algorithms) related questions..`;
      
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
        })
      });

      if (!response.ok) {
        ws.send(JSON.stringify({ type: "error", content: `Ollama responded with status ${response.status}` }));
        return;
      }

      if (!response.body) {
        ws.send(JSON.stringify({ type: "error", content: "No response body from Ollama" }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullResponse = "";

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
              // Send tokens as they arrive in a structured format
              ws.send(JSON.stringify({ 
                type: "stream", 
                content: json.response 
              }));
            }
            if (json.done) {
              // Send completion signal
              ws.send(JSON.stringify({ 
                type: "complete", 
                content: fullResponse 
              }));
              break;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

    } catch (error) {
      console.error(`[${id}] ERROR:`, error.message);
      ws.send(JSON.stringify({ 
        type: "error", 
        content: error.message 
      }));
    }
  });

  ws.on("close", () => console.log(`[${id}] CLOSED`));
  ws.on("error", (e) => console.error(`[${id}] ERROR:`, e.message));
});

server.listen(PORT, () => {
  console.log(`\nServer running on ${PORT}`);
  console.log(`Model: ${MODEL_NAME}`);
  console.log(`Ollama: ${OLLAMA_URL}\n`);
});
