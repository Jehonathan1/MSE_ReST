// websocketServer.js
const WebSocket = require('ws');
const net = require('net');
const { EventEmitter } = require('events');
const config = require('../config/config');

class MSEWebSocketServer extends EventEmitter {
    constructor(httpServer) {
        super();
        
        this.clients = new Set();
        this.mseSocket = null;
        this.messageId = 1;
        this.isConnecting = false;
        this.reconnectTimeout = null;
        
        // Initialize WebSocket connection
        this.connectToWebSocket();
    }

    connectToWebSocket() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        try {
            // Connect to MSE's WebSocket actor
            console.log(`Connecting to MSE WebSocket actor at ws://${config.MSE_HOST}:${config.MSE_WEBSOCKET_PORT}`);
            
            this.ws = new WebSocket(`ws://${config.MSE_HOST}:${config.MSE_WEBSOCKET_PORT}`);

            this.ws.on('open', () => {
                console.log('Connected to MSE WebSocket actor');
                this.isConnecting = false;
                
                // Send protocol negotiation
                this.sendCommand(`protocol ${config.PEPTALK_CAPABILITIES}`);
                
                // After protocol negotiation, start watching for state changes
                this.sendCommand('get /directory/shows');  // Example command to test
                
                // Set up periodic status check
                setInterval(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.sendCommand('get /directory/shows');
                    }
                }, 5000);
            });

            this.ws.on('message', (data) => {
                const message = data.toString('utf8');
                console.log('Received from MSE:', message);
                this.handleMessage(message);
            });

            this.ws.on('error', (error) => {
                console.error('MSE WebSocket error:', error.message);
                this.handleDisconnect();
            });

            this.ws.on('close', () => {
                console.log('MSE WebSocket connection closed');
                this.handleDisconnect();
            });

        } catch (error) {
            console.error('Failed to connect to MSE:', error);
            this.handleDisconnect();
        }
    }

    handleDisconnect() {
        this.isConnecting = false;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(() => this.connectToWebSocket(), 5000);
    }

    handleMessage(message) {
        try {
            console.log('Processing message:', message);
            
            // Handle protocol response
            if (message.startsWith('1 protocol')) {
                console.log('Protocol negotiation successful');
                return;
            }
            
            // Handle error responses
            if (message.includes('error')) {
                console.error('Error from MSE:', message);
                return;
            }

            // Handle data responses
            if (message.includes('<feed>') || message.includes('<entry>')) {
                console.log('Received data feed');
                this.broadcast(message);
                return;
            }

            // Log other messages for debugging
            console.log('Unhandled message type:', message);
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    sendCommand(command) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            const msg = `${this.messageId} ${command}\r\n`;
            console.log('Sending command:', msg);
            this.ws.send(msg);
            this.messageId++;
            return true;
        } else {
            console.error('Cannot send command - not connected to MSE');
            return false;
        }
    }

    broadcast(message) {
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    shutdown() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        
        if (this.ws?.readyState === WebSocket.OPEN) {
            // Unregister from state changes
            this.sendCommand('unregister NTK_states');
            this.ws.close();
        }
    }
}

module.exports = MSEWebSocketServer;