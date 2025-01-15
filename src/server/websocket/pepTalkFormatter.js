// pepTalkFormatter.js

class PepTalkFormatter {
    static formatCommand(command, ...args) {
        // Escape special characters in arguments
        const escapedArgs = args.map(arg => {
            if (typeof arg === 'string') {
                return this.escapeString(arg);
            }
            return arg;
        });

        // Join command and arguments with spaces
        return `${command} ${escapedArgs.join(' ')}\r\n`;
    }

    static escapeString(str) {
        // Escape special characters according to PepTalk specification
        return str
            .replace(/\\/g, '\\\\')   // Escape backslashes
            .replace(/"/g, '\\"')     // Escape quotes
            .replace(/\r/g, '\\r')    // Escape carriage returns
            .replace(/\n/g, '\\n')    // Escape newlines
            .replace(/\t/g, '\\t');   // Escape tabs
    }

    static formatGetCommand(path) {
        return this.formatCommand('get', path);
    }

    static formatSetCommand(path, value) {
        return this.formatCommand('set', path, `"${value}"`);
    }

    static formatScheduleCommand(command, elementUrl) {
        return this.formatCommand('schedule', command, `"${elementUrl}"`);
    }

    static formatProtocolCommand(protocol = 'peptalk') {
        return this.formatCommand('protocol', protocol);
    }

    static parseResponse(response) {
        // Split response into lines
        const lines = response.split('\r\n');
        
        // Parse status line
        const statusLine = lines[0];
        const [status, ...statusMessage] = statusLine.split(' ');
        
        // Parse headers and body
        let currentSection = 'headers';
        const headers = new Map();
        let body = '';
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            
            if (line === '') {
                currentSection = 'body';
                continue;
            }
            
            if (currentSection === 'headers') {
                const [key, ...value] = line.split(': ');
                headers.set(key, value.join(': '));
            } else {
                body += line + '\n';
            }
        }

        return {
            status,
            statusMessage: statusMessage.join(' '),
            headers,
            body: body.trim()
        };
    }
}

module.exports = PepTalkFormatter;