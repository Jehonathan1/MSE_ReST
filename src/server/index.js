// src/server/index.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const MSEWebSocketServer = require('./websocket/websocketServer');
const config = require('./config/config');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize MSE WebSocket client
const mseClient = new MSEWebSocketServer();

// Store connected web clients
const clients = new Set();

// Handle WebSocket connections from web clients
wss.on('connection', (ws) => {
    console.log('Web client connected');
    clients.add(ws);

    // Forward MSE messages to web client
    mseClient.on('message', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    ws.on('close', () => {
        console.log('Web client disconnected');
        clients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
    });
});

// Forward broadcast messages from MSE to all web clients
mseClient.on('broadcast', (message) => {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.get('/api/shows', (req, res) => {
    console.log('Getting shows list');
    if (mseClient.getShows()) {
        res.json({ message: 'Request sent successfully' });
    } else {
        res.status(503).json({ error: 'Not connected to MSE' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ 
        error: 'Internal Server Error',
        message: err.message 
    });
});

// Start server
const PORT = config.PORT;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});