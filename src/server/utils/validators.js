const { AppError } = require('./errorHandler');

class RequestValidator {
    static validateProfileCommand(req) {
        const { commandUrl, elementUrl } = req.body;

        if (!commandUrl) {
            throw new AppError('Command URL is required', 400);
        }

        if (!elementUrl) {
            throw new AppError('Element URL is required', 400);
        }

        // Validate URL format
        try {
            new URL(commandUrl);
            new URL(elementUrl);
        } catch (error) {
            throw new AppError('Invalid URL format', 400);
        }

        // Validate command type
        const validCommands = ['take', 'continue', 'out', 'cleanup', 'initialize'];
        const commandType = commandUrl.split('/').pop();
        
        if (!validCommands.includes(commandType)) {
            throw new AppError('Invalid command type', 400);
        }

        return true;
    }

    static validatePlaylistRequest(req) {
        const { url } = req.query;

        if (!url) {
            throw new AppError('Playlist URL is required', 400);
        }

        try {
            new URL(url);
        } catch (error) {
            throw new AppError('Invalid playlist URL format', 400);
        }

        // Check if URL points to a playlist resource
        if (!url.includes('/element_collection/') && !url.includes('/directory/')) {
            throw new AppError('Invalid playlist URL path', 400);
        }

        return true;
    }

    static validateShowRequest(showUrl) {
        if (!showUrl) {
            throw new AppError('Show URL is required', 400);
        }

        try {
            new URL(showUrl);
        } catch (error) {
            throw new AppError('Invalid show URL format', 400);
        }

        // Check if URL points to a show resource
        if (!showUrl.includes('/directory/shows/')) {
            throw new AppError('Invalid show URL path', 400);
        }

        return true;
    }

    static validateTemplateRequest(templateUrl) {
        if (!templateUrl) {
            throw new AppError('Template URL is required', 400);
        }

        try {
            new URL(templateUrl);
        } catch (error) {
            throw new AppError('Invalid template URL format', 400);
        }

        // Check if URL points to a template resource
        if (!templateUrl.includes('/templates/')) {
            throw new AppError('Invalid template URL path', 400);
        }

        return true;
    }
}

// Helper functions for URL validation
const urlPatterns = {
    isShowUrl: (url) => url.includes('/directory/shows/'),
    isPlaylistUrl: (url) => url.includes('/directory/playlists/') || url.includes('/element_collection/'),
    isTemplateUrl: (url) => url.includes('/templates/'),
    isProfileUrl: (url) => url.includes('/profiles/')
};

// Helper functions for content validation
const contentValidators = {
    isValidXML: (content) => {
        try {
            if (typeof content !== 'string') return false;
            const parser = new DOMParser();
            const doc = parser.parseFromString(content, 'application/xml');
            return !doc.querySelector('parsererror');
        } catch (error) {
            return false;
        }
    },

    isValidJSON: (content) => {
        try {
            JSON.parse(content);
            return true;
        } catch (error) {
            return false;
        }
    }
};

module.exports = {
    RequestValidator,
    urlPatterns,
    contentValidators
};