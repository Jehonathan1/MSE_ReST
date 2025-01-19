// websocketServer.js
const WebSocket = require('ws');
const net = require('net');
const { EventEmitter } = require('events');
const config = require('../config/config');

class MSEWebSocketServer extends EventEmitter {
    constructor(httpServer) {
        super();
        
        this.ws = null;
        this.messageId = 1;
        this.isConnecting = false;
        this.reconnectTimeout = null;
        this.monitorInterval = null;
        
        // Initialize WebSocket connection
        this.connectToWebSocket();
    }

    connectToWebSocket() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        try {
            console.log(`Connecting to MSE WebSocket actor at ws://${config.MSE_HOST}:${config.MSE_WEBSOCKET_PORT}`);
            
            this.ws = new WebSocket(`ws://${config.MSE_HOST}:${config.MSE_WEBSOCKET_PORT}`);

            this.ws.on('open', () => {
                console.log('Connected to MSE WebSocket actor');
                this.isConnecting = false;
                
                // Send protocol negotiation
                this.sendCommand(`protocol ${config.PEPTALK_CAPABILITIES}`);
                
                // Start monitoring state
                this.startMonitoring();
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

    startMonitoring() {
        this.queryStatus();
        // Query status every 2 seconds
        this.monitorInterval = setInterval(() => {
            this.queryStatus();
        }, 2000);
    }

    queryStatus() {
        this.sendCommand('get /state'); // Get current show and profile state
    }

    handleMessage(message) {
        try {
            console.log('📥 Processing MSE message:', message);
            
            // Handle protocol negotiation
            if (message.startsWith('1 protocol')) {
                console.log('🤝 Protocol negotiation successful');
                return;
            }

            // Handle dispatch_element messages (template takes)
            if (message.includes('[dispatch_element]')) {
                console.log('🎬 Found template action');
                const action = this.parseTemplateAction(message);
                if (action) {
                    this.broadcast(JSON.stringify({
                        type: 'action',
                        data: action
                    }));
                }
                return;
            }

            // Handle state response (show/profile info)
            if (message.includes('state')) {
                console.log('📊 Processing state info');
                const state = this.parseState(message);
                if (state) {
                    if (state.show) {
                        this.broadcast(JSON.stringify({
                            type: 'currentShow',
                            data: state.show
                        }));
                    }
                    if (state.profile) {
                        this.broadcast(JSON.stringify({
                            type: 'currentProfile',
                            data: state.profile
                        }));
                    }
                }
                return;
            }

            // Handle template content
            if (message.includes('payload') && message.includes('field')) {
                console.log('📄 Processing template content');
                const content = this.parseTemplateContent(message);
                if (content) {
                    this.broadcast(JSON.stringify({
                        type: 'templateContent',
                        data: content
                    }));
                }
                return;
            }

            console.log('⚠️ Unhandled message type:', message);
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    parseState(message) {
        try {
            let state = {};
            
            // Extract show info from trio_clients entry
            const showMatch = message.match(/show="([^"]*?)"/);
            if (showMatch) {
                const showPath = showMatch[1];
                state.show = {
                    name: showPath.split('/').pop(), // Get last part of path
                    path: showPath,
                    status: 'active'
                };
            }

            // Extract profile info from trio_clients entry
            const profileMatch = message.match(/profile="([^"]*?)"/);
            if (profileMatch) {
                state.profile = {
                    name: profileMatch[1],
                    status: 'active'
                };
            }

            // If no matches found, try last_taken_element
            if (!state.profile) {
                const lastProfileMatch = message.match(/name="profile">([^<]*)<\/entry>/);
                if (lastProfileMatch) {
                    const profilePath = lastProfileMatch[1];
                    state.profile = {
                        name: profilePath.split('/').pop(), // Get last part of path
                        status: 'active'
                    };
                }
            }

            console.log('Parsed state:', state);
            return state;
        } catch (error) {
            console.error('Error parsing state:', error);
            return null;
        }
    }

    parseTemplateAction(message) {
        try {
            // [dispatch_element] <127.0.0.1:56419> [Brand()] Run (take) /storage/shows/{UUID}/elements/1003
            const regex = /\[([^\]]+)\].*\[([^\]]+)\].*\((take|continue|out)\)\s+([^\s]+)/;
            const match = message.match(regex);
            
            if (match) {
                const action = {
                    type: match[3],
                    template: match[2],
                    path: match[4],
                    timestamp: new Date().toISOString()
                };
                
                // Get template content
                this.getTemplateContent(action.path);
                
                return action;
            }
            return null;
        } catch (error) {
            console.error('Error parsing template action:', error);
            return null;
        }
    }

    getTemplateContent(path) {
        return this.sendCommand(`get ${path}`);
    }

    parseTemplateContent(message) {
        try {
            let content = [];
            // Extract field values from the payload
            const fields = message.match(/<field[^>]*>(.*?)<\/field>/g) || [];
            
            fields.forEach(field => {
                const valueMatch = field.match(/<value[^>]*>(.*?)<\/value>/);
                if (valueMatch) {
                    content.push(valueMatch[1]);
                }
            });

            return {
                timestamp: new Date().toISOString(),
                content: content
            };
        } catch (error) {
            console.error('Error parsing template content:', error);
            return null;
        }
    }

    handleDisconnect() {
        this.isConnecting = false;
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(() => this.connectToWebSocket(), 5000);
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
        try {
            console.log('🔄 Broadcasting message to clients:', typeof message, message);
            this.emit('broadcast', message);
        } catch (error) {
            console.error('❌ Error broadcasting message:', error);
        }
    }

    shutdown() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}

module.exports = MSEWebSocketServer;