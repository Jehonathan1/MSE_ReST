// websocketServer.js
const WebSocket = require('ws');
const net = require('net');
const { EventEmitter } = require('events');

class MSEWebSocketServer extends EventEmitter {
    constructor(httpServer) {
        super();
        
        // Create WebSocket server attached to HTTP server
        this.wss = new WebSocket.Server({ server: httpServer });
        
        // Track active connections
        this.clients = new Set();
        
        // Connection to MSE's PepTalk port
        this.mseSocket = null;
        
        // Initialize
        this.initialize();
    }

    initialize() {
        // Handle WebSocket connections
        this.wss.on('connection', (ws) => this.handleConnection(ws));
        
        // Connect to MSE PepTalk server (default port 8594)
        this.connectToMSE();
    }

    connectToMSE() {
        this.mseSocket = new net.Socket();

        this.mseSocket.connect(8594, 'localhost', () => {
            console.log('Connected to MSE PepTalk server');
            
            // Send initial protocol negotiation
            this.mseSocket.write('protocol peptalk\r\n');
        });

        this.mseSocket.on('data', (data) => {
            // Broadcast MSE response to all connected clients
            const message = data.toString('utf8');
            this.broadcast(message);
        });

        this.mseSocket.on('error', (error) => {
            console.error('MSE connection error:', error);
            // Try to reconnect after a delay
            setTimeout(() => this.connectToMSE(), 5000);
        });

        this.mseSocket.on('close', () => {
            console.log('MSE connection closed');
            // Try to reconnect after a delay
            setTimeout(() => this.connectToMSE(), 5000);
        });
    }

    handleConnection(ws) {
        console.log('New WebSocket client connected');
        this.clients.add(ws);

        ws.on('message', (message) => {
            try {
                // Forward client message to MSE
                if (this.mseSocket && this.mseSocket.writable) {
                    this.mseSocket.write(message + '\r\n');
                }
            } catch (error) {
                console.error('Error handling message:', error);
                ws.send(JSON.stringify({
                    type: 'error',
                    data: { message: 'Failed to process command' }
                }));
            }
        });

        ws.on('close', () => {
            console.log('Client disconnected');
            this.clients.delete(ws);
        });

        ws.on('error', (error) => {
            console.error('WebSocket client error:', error);
            this.clients.delete(ws);
        });
    }

    broadcast(message) {
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    // Parse PepTalk messages into structured format
    parsePepTalkMessage(message) {
        try {
            // Basic PepTalk message parsing
            const lines = message.split('\r\n');
            const command = lines[0];
            const body = lines.slice(1).join('\r\n');

            return {
                command,
                body,
                raw: message
            };
        } catch (error) {
            console.error('Error parsing PepTalk message:', error);
            return null;
        }
    }

    // Close all connections
    shutdown() {
        if (this.mseSocket) {
            this.mseSocket.end();
        }
        
        this.clients.forEach(client => {
            try {
                client.close();
            } catch (error) {
                console.error('Error closing client connection:', error);
            }
        });
        
        this.wss.close();
    }
}

module.exports = MSEWebSocketServer;