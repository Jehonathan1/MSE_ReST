const axios = require('axios');
const xml2js = require('xml2js');

const MSE_BASE_URL = 'http://127.0.0.1:8580';

class MSEService {
    constructor() {
        this.parser = new xml2js.Parser({
            explicitArray: false,
            mergeAttrs: true,
        });
        
        this.client = axios.create({
            baseURL: MSE_BASE_URL,
            headers: {
                'Accept': 'application/atom+xml'
            }
        });
    }

    async fetchAllShows() {
        try {
            console.log('Fetching shows from:', `${MSE_BASE_URL}/directory/shows/`);
            const response = await this.client.get('/directory/shows/');
            console.log('Response status:', response.status);
            
            const parsedData = await this.parser.parseStringPromise(response.data);
            console.log('Parsed data:', JSON.stringify(parsedData, null, 2));

            if (!parsedData.feed || !parsedData.feed.entry) {
                console.log('No entries found');
                return [];
            }

            const entries = Array.isArray(parsedData.feed.entry) ? 
                parsedData.feed.entry : [parsedData.feed.entry];

            return entries
                .filter(entry => {
                    const categories = Array.isArray(entry.category) ? 
                        entry.category : [entry.category];
                    return categories.some(cat => cat.term === 'show');
                })
                .map(entry => ({
                    name: entry.title,
                    url: entry.link.find(l => l.rel === 'self')?.href,
                    alternateUrl: entry.link.find(l => l.rel === 'alternate')?.href,
                    pages: [],
                    templates: [],
                    playlists: []
                }));

        } catch (error) {
            console.error('Error fetching shows:', error);
            if (error.response) {
                console.error('Response data:', error.response.data);
                console.error('Response status:', error.response.status);
            }
            return [];
        }
    }

    async fetchProfiles() {
        try {
            const response = await this.client.get('/profiles');
            const parsedData = await this.parser.parseStringPromise(response.data);
            
            if (!parsedData.feed || !parsedData.feed.entry) {
                return [];
            }

            const entries = Array.isArray(parsedData.feed.entry) ? 
                parsedData.feed.entry : [parsedData.feed.entry];

            return entries.map(entry => ({
                name: entry.title,
                takeUrl: entry.link.find(l => l.rel === 'take')?.href,
                continueUrl: entry.link.find(l => l.rel === 'continue')?.href,
                outUrl: entry.link.find(l => l.rel === 'out')?.href,
                initializeUrl: entry.link.find(l => l.rel === 'initialize')?.href,
                cleanupUrl: entry.link.find(l => l.rel === 'cleanup')?.href
            }));
        } catch (error) {
            console.error('Error fetching profiles:', error);
            return [];
        }
    }

    async fetchPlaylistContent(playlistUrl) {
        try {
            const response = await this.client.get(playlistUrl);
            const parsedData = await this.parser.parseStringPromise(response.data);
            
            if (!parsedData.feed || !parsedData.feed.entry) {
                return [];
            }

            const entries = Array.isArray(parsedData.feed.entry) ? 
                parsedData.feed.entry : [parsedData.feed.entry];

            return entries.map(entry => ({
                title: entry.title,
                selfUrl: entry.link.find(l => l.rel === 'self')?.href,
                template: entry.content?.payload?.model ? 
                    entry.content.payload.model.split('/mastertemplates/').pop() : 
                    'Unknown Template'
            }));
        } catch (error) {
            console.error('Error fetching playlist content:', error);
            return [];
        }
    }

    async executeProfileCommand(commandUrl, elementUrl) {
        try {
            await this.client.post(commandUrl, elementUrl, {
                headers: {
                    'Content-Type': 'text/plain'
                }
            });
            return true;
        } catch (error) {
            console.error('Error executing profile command:', error);
            throw error;
        }
    }
}

module.exports = new MSEService();