// index.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const MSEWebSocketServer = require('./websocket/websocketServer');

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server instance
const server = http.createServer(app);

// Initialize WebSocket server
const wss = new MSEWebSocketServer(server);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Basic route for testing
app.get('/test', (req, res) => {
    res.json({ message: 'Server is running!' });
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
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('WebSocket server available on ws://localhost:${PORT}');
    console.log('Connected to MSE PepTalk server on localhost:8594');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    wss.shutdown();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});