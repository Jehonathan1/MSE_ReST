// WebSocketService.js

class WebSocketService {
    constructor() {
        // MSE WebSocket typically runs on port 8595 (MSE port + 1)
        this.ws = null;
        this.messageHandlers = new Map();
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    connect() {
        return new Promise((resolve, reject) => {
            try {
                // Connect to MSE WebSocket (typically port 8595)
                this.ws = new WebSocket('ws://localhost:8595');

                this.ws.onopen = () => {
                    console.log('WebSocket Connected');
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    
                    // Negotiate protocol (PepTalk)
                    this.send('protocol peptalk');
                    resolve();
                };

                this.ws.onclose = () => {
                    console.log('WebSocket Disconnected');
                    this.connected = false;
                    this.handleReconnect();
                };

                this.ws.onerror = (error) => {
                    console.error('WebSocket Error:', error);
                    reject(error);
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

            } catch (error) {
                console.error('WebSocket Connection Error:', error);
                reject(error);
            }
        });
    }

    handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), 2000 * this.reconnectAttempts);
        }
    }

    send(message) {
        if (this.connected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(message);
        } else {
            console.error('WebSocket not connected');
        }
    }

    // Register handlers for different message types
    on(type, handler) {
        this.messageHandlers.set(type, handler);
    }

    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            const handler = this.messageHandlers.get(message.type);
            if (handler) {
                handler(message.data);
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    // MSE specific commands
    async getShows() {
        this.send('get /directory/shows');
    }

    async getShowDetails(showPath) {
        this.send(`get ${showPath}`);
    }

    async getPlaylistContent(playlistPath) {
        this.send(`get ${playlistPath}`);
    }

    async executeCommand(command, elementUrl) {
        this.send(`schedule ${command} "${elementUrl}"`);
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

export default new WebSocketService();